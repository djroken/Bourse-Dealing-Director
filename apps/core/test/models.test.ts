import { describe, expect, it } from 'vitest';
import { cleanRationale, createAdvisor, isFreeOpenRouterModel, parseModelRef, parseModelView, type Fetcher } from '../src/models';

const ctx = { role: 'Quant / Signals', mandate: 'Find edges.', symbol: 'BTC-USDT', price: 100, change24h: 2 };
const reply = (content: string, shape: 'ollama' | 'openrouter') =>
  shape === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] };
const okFetch = (content: string, shape: 'ollama' | 'openrouter', calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []): Fetcher =>
  async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => reply(content, shape) };
  };
const GOOD = '{"side":"buy","confidence":0.7,"rationale":"Momentum is up."}';

describe('model ids', () => {
  it('parses the three provider prefixes and leaves everything else to the stub rule', () => {
    expect(parseModelRef('ollama:llama3.2')).toEqual({ provider: 'ollama', model: 'llama3.2', freeOnly: false });
    expect(parseModelRef('openrouter:anthropic/claude-sonnet-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', freeOnly: false });
    expect(parseModelRef('openrouter-free:meta-llama/llama-3.3-70b-instruct:free')).toMatchObject({ provider: 'openrouter', freeOnly: true });
    expect(parseModelRef('claude-sonnet-4.5')).toBeUndefined();
    expect(parseModelRef('ollama:')).toBeUndefined();
  });
  it('knows which OpenRouter ids are free', () => {
    expect(isFreeOpenRouterModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isFreeOpenRouterModel('anthropic/claude-sonnet-4.5')).toBe(false);
    expect(isFreeOpenRouterModel('x:free-not')).toBe(false);
  });
});

describe('parsing model output (untrusted)', () => {
  it('accepts JSON wrapped in prose or fences, normalises the side', () => {
    expect(parseModelView('Sure!\n```json\n' + GOOD + '\n```')).toEqual({ side: 'BUY', confidence: 0.7, rationale: 'Momentum is up.' });
  });
  it('rejects anything that is not a valid view', () => {
    for (const bad of ['', 'no json', '{"side":"YOLO","confidence":1,"rationale":"x"}', '{"side":"BUY","confidence":9,"rationale":"x"}', '{"side":"BUY","confidence":0.5}', '{"side":"BUY","confidence":0.5,"rationale":""}']) {
      expect(parseModelView(bad), bad).toBeUndefined();
    }
  });
  it('strips control characters and caps the rationale', () => {
    expect(cleanRationale('a\u0000b\n\nc\u001b[31m')).toBe('a b c [31m');
    expect(cleanRationale('x'.repeat(1000))).toHaveLength(240);
  });
  it('ignores extra fields such as a size the model tries to choose', () => {
    const v = parseModelView('{"side":"BUY","confidence":0.5,"rationale":"x","size":1000000,"symbol":"ETH-USDT"}')!;
    expect(Object.keys(v).sort()).toEqual(['confidence', 'rationale', 'side']);
  });
});

describe('advisor', () => {
  it('calls local Ollama without a key', async () => {
    const calls: any[] = [];
    const a = createAdvisor({ fetcher: okFetch(GOOD, 'ollama', calls), ollamaHost: 'http://localhost:11434/' });
    const r = await a.advise('ollama:llama3.2', ctx, 0.3);
    expect(r).toMatchObject({ ok: true, view: { side: 'BUY', confidence: 0.7, rationale: 'Momentum is up.' } });
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].body).toMatchObject({ model: 'llama3.2', stream: false, options: { temperature: 0.3 } });
    expect(JSON.stringify(calls[0])).not.toMatch(/Bearer/);
  });

  it('OpenRouter: any model is allowed on openrouter:, and needs a key', async () => {
    const calls: any[] = [];
    const noKey = createAdvisor({ fetcher: okFetch(GOOD, 'openrouter', calls) });
    expect(await noKey.advise('openrouter:anthropic/claude-sonnet-4.5', ctx, 0.3)).toEqual({ ok: false, reason: 'no OpenRouter key saved in core' });
    expect(calls).toHaveLength(0);

    const a = createAdvisor({ fetcher: okFetch(GOOD, 'openrouter', calls), openrouterKey: () => 'sk-or-test' });
    expect((await a.advise('openrouter:anthropic/claude-sonnet-4.5', ctx, 0.3)).ok).toBe(true);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-or-test');
    expect(calls[0].body.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('openrouter-free: refuses paid models without making a request', async () => {
    const calls: any[] = [];
    const a = createAdvisor({ fetcher: okFetch(GOOD, 'openrouter', calls), openrouterKey: () => 'k' });
    expect((await a.advise('openrouter-free:anthropic/claude-sonnet-4.5', ctx, 0.3)).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await a.advise('openrouter-free:meta-llama/llama-3.3-70b-instruct:free', ctx, 0.3)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('enforces the daily cap and resets it on a new UTC day', async () => {
    let t = Date.parse('2026-10-11T12:00:00Z');
    const a = createAdvisor({ fetcher: okFetch(GOOD, 'openrouter'), openrouterKey: () => 'k', dailyCap: { ollama: 0, openrouter: 2 }, now: () => t });
    const id = 'openrouter:x/y';
    expect((await a.advise(id, ctx, 0)).ok).toBe(true);
    expect((await a.advise(id, ctx, 0)).ok).toBe(true);
    expect(await a.advise(id, ctx, 0)).toEqual({ ok: false, reason: 'daily cap of 2 OpenRouter calls reached' });
    expect(a.status().openrouter).toMatchObject({ used: 2, cap: 2, keySet: true });
    t += 24 * 3600 * 1000;
    expect((await a.advise(id, ctx, 0)).ok).toBe(true);
  });

  it('cap 0 means unlimited', async () => {
    const a = createAdvisor({ fetcher: okFetch(GOOD, 'ollama'), dailyCap: { ollama: 0, openrouter: 0 } });
    for (let i = 0; i < 50; i++) expect((await a.advise('ollama:m', ctx, 0)).ok).toBe(true);
  });

  it('turns HTTP errors, timeouts and junk replies into reasons, never throws', async () => {
    const mk = (f: Fetcher) => createAdvisor({ fetcher: f, openrouterKey: () => 'k', timeoutMs: 20 });
    expect(await mk(async () => ({ ok: false, status: 429, json: async () => ({}) })).advise('openrouter:x/y', ctx, 0)).toEqual({ ok: false, reason: 'rate limited (429)' });
    expect(await mk(async () => ({ ok: false, status: 500, json: async () => ({}) })).advise('ollama:m', ctx, 0)).toEqual({ ok: false, reason: 'HTTP 500' });
    expect(await mk(async () => { throw new Error('ECONNREFUSED'); }).advise('ollama:m', ctx, 0)).toEqual({ ok: false, reason: 'ECONNREFUSED' });
    const hang: Fetcher = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    expect(await mk(hang).advise('ollama:m', ctx, 0)).toEqual({ ok: false, reason: 'timed out' });
    expect((await mk(okFetch('lol no', 'ollama')).advise('ollama:m', ctx, 0))).toMatchObject({ ok: false, reason: 'reply was not the expected JSON' });
  });

  it('never puts the key in the status', () => {
    const a = createAdvisor({ openrouterKey: () => 'sk-or-secret' });
    expect(JSON.stringify(a.status())).not.toContain('sk-or-secret');
  });
});

describe('the free-model allowance', () => {
  it('free models share their own daily budget (just under OpenRouter\'s 50), with a reason that says what to do', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let t = Date.UTC(2026, 9, 30, 23, 0);
    const a = createAdvisor({ fetcher: okFetch(GOOD, 'openrouter', calls), openrouterKey: () => 'sk-or-test', freeDailyCap: 2, now: () => t });
    expect(a.freeLeft!()).toBe(2);
    expect((await a.advise('openrouter-free:x/y:free', ctx, 0.2)).ok).toBe(true);
    expect((await a.advise('openrouter:x/y:free', ctx, 0.2)).ok).toBe(true); // a :free model under either prefix counts
    const third = await a.advise('openrouter-free:x/y:free', ctx, 0.2);
    expect(third).toMatchObject({ ok: false, reason: expect.stringContaining("today's free-model budget is used (2 calls") });
    expect(third.ok ? '' : third.reason).toContain('OPENROUTER_FREE_DAILY_CAP');
    expect((await a.advise('openrouter:anthropic/claude-sonnet-4.5', ctx, 0.2)).ok).toBe(true); // paid models aren't held back
    expect(a.status().openrouter.free).toEqual({ used: 2, cap: 2 });
    expect(calls).toHaveLength(3);
    t += 2 * 3_600_000; // next UTC day
    expect(a.freeLeft!()).toBe(2);
    expect(createAdvisor({ freeDailyCap: 0 }).freeLeft!()).toBeNull();
  });
});
