import { describe, expect, it } from 'vitest';
import { AgentUsageMsgSchema } from 'shared';
import { createCatalog, parseOllamaTags, parseOpenRouterFree } from '../src/catalog';
import { createEngine, type FloorSocket } from '../src/engine';
import { loadConfig } from '../src/config';
import { buildServer } from '../src/server';

const page1 = {
  data: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct (free)', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude', pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'sneaky/model:free', name: 'Not actually free', pricing: { prompt: '0.000001', completion: '0' } },
    { id: 'bad id with spaces:free', name: 'x', pricing: { prompt: '0', completion: '0' } },
  ],
  links: { next: 'https://openrouter.ai/api/v1/models?page=2' },
};
const page2 = { data: [{ id: 'deepseek/deepseek-chat:free', name: 'DeepSeek V3 (free)‮', pricing: { prompt: '0', completion: '0' } }], links: { next: 'https://evil.example/models' } };

describe('model catalog', () => {
  it('keeps only genuinely free OpenRouter models with clean ids, prefixed for the free-only adapter', () => {
    expect(parseOpenRouterFree(page1)).toEqual([{ id: 'openrouter-free:meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct (free)', context: 131072 }]);
    expect(parseOpenRouterFree('nope')).toEqual([]);
    expect(parseOllamaTags({ models: [{ name: 'llama3.2:1b' }, { name: '../etc' }, 7] })).toEqual([{ id: 'ollama:llama3.2:1b', name: 'llama3.2:1b', context: null }]);
  });
  it('follows OpenRouter\'s pages (only on openrouter.ai), caches, and reports Ollama and the key', async () => {
    const urls: string[] = [];
    let t = 0;
    const cat = createCatalog({
      now: () => t, ollamaHost: 'http://127.0.0.1:11434/', openrouterKeySet: () => true,
      getJson: async (u) => {
        urls.push(u);
        if (u.includes('/api/tags')) return { models: [{ name: 'qwen2.5:0.5b' }] };
        return u.includes('page=2') ? page2 : page1;
      },
    });
    const c = await cat.get();
    expect(c.openrouter.free.map((m) => m.id)).toEqual(['openrouter-free:deepseek/deepseek-chat:free', 'openrouter-free:meta-llama/llama-3.3-70b-instruct:free']);
    expect(c.openrouter.free[0]!.name).toBe('DeepSeek V3 (free)');
    expect(c.openrouter.keySet).toBe(true);
    expect(c.ollama).toEqual({ host: 'http://127.0.0.1:11434', reachable: true, models: [{ id: 'ollama:qwen2.5:0.5b', name: 'qwen2.5:0.5b', context: null }] });
    expect(urls.filter((u) => u.includes('openrouter'))).toEqual(['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/models?page=2']);
    t += 10 * 60_000;
    await cat.get();
    expect(urls.filter((u) => u.includes('openrouter'))).toHaveLength(2); // cached for an hour
  });
  it('an unreachable OpenRouter or Ollama is reported, not thrown', async () => {
    const cat = createCatalog({ ollamaHost: 'http://x', openrouterKeySet: () => false, getJson: async () => { throw new Error('fetch failed'); } });
    expect(await cat.get()).toMatchObject({ openrouter: { keySet: false, free: [], error: 'fetch failed' }, ollama: { reachable: false, models: [] } });
  });
});

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  on() {
    return this;
  }
}

describe('a failed model call reaches the Desk', () => {
  it('usage carries the reason, and clears it after a call that works', () => {
    const engine = createEngine({ now: () => 1_000_000 });
    const ws = new FakeSocket();
    engine.addClient(ws);
    const pico = engine.agents.find((a) => a.config.role === 'Quant / Signals')!;
    engine.recordUsage(pico, undefined, 'no OpenRouter key: set one in Setup or OPENROUTER_API_KEY');
    engine.recordUsage(pico, undefined, 'no OpenRouter key: set one in Setup or OPENROUTER_API_KEY'); // same reason: not repeated
    engine.recordUsage(pico, { promptTokens: 10, completionTokens: 5, latencyMs: 300, costUsd: 0 });
    const usage = ws.sent.filter((m) => m.type === 'usage');
    for (const u of usage) expect(AgentUsageMsgSchema.safeParse(u).success).toBe(true);
    expect(usage.map((u) => u.lastError)).toEqual(['no OpenRouter key: set one in Setup or OPENROUTER_API_KEY', null]);
    expect(usage[1]).toMatchObject({ callsToday: 1, tokensToday: 15 });
  });
});

describe('server: /models/catalog', () => {
  it('answers even offline', async () => {
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1', BOURSE_NEWS_FEEDS: 'off' }), feedIntervalMs: 60_000, persist: false, ideaLog: false, talkMin: 0 };
    const core = buildServer(config, { feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    const port = await core.start();
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/models/catalog`)).json()).toMatchObject({ openrouter: { free: [], error: 'offline' }, ollama: { reachable: false } });
    } finally {
      await core.stop();
    }
  });
});
