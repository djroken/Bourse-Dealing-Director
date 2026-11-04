import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentChatMsgSchema } from 'shared';
import { createEngine, type FloorSocket } from '../src/engine';
import { createLessons, parseLesson, parseLessons } from '../src/lessons';
import { createTalk } from '../src/talk';
import { loadConfig } from '../src/config';
import { buildServer } from '../src/server';
import type { Advisor } from '../src/models';

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  on() {
    return this;
  }
  of(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
}
const tick = (price: number, change24h: number) => ({ price, change24h, source: 'binance' });

function floor(reply = '{"lesson":"I bought SOL after a 4% day with no volume read: chasing. Wait for a pullback."}', freeLeft: number | null = null) {
  let t = Date.UTC(2026, 10, 4, 22, 0);
  const prompts: Array<{ model: string; system: string; user: string }> = [];
  const advised: Array<{ notes?: string[] }> = [];
  const advisor: Advisor = {
    handles: (id) => id.startsWith('ollama:') || id.startsWith('openrouter'),
    advise: async (_id, ctx) => (advised.push(ctx), { ok: true, view: { side: 'BUY', confidence: 0.8, rationale: 'Trend up.' } }),
    status: () => ({ ollama: { host: '', used: 0, cap: 0 }, openrouter: { keySet: true, used: 0, cap: 0 } }),
    freeLeft: () => freeLeft,
    converse: async (model, p) => (prompts.push({ model, ...p }), { ok: true, text: p.system.includes('write yourself ONE short lesson') ? reply : '{"say":"Ok.","idea":null}' }),
  };
  let lessons: ReturnType<typeof createLessons> | undefined;
  const engine = createEngine({ now: () => t, cooldownMs: 0, modelCooldownMs: 0, advisor, onIdeaResolved: (r) => lessons?.onResolved(r), notesFor: (id) => lessons?.notesFor(id) ?? [] });
  const saved: unknown[] = [];
  lessons = createLessons({ engine, now: () => t, onSave: (all) => saved.push(all) });
  const ws = new FakeSocket();
  engine.addClient(ws);
  const quant = engine.agents.find((a) => a.config.role === 'Quant / Signals')!;
  quant.config.model = 'ollama:qwen3';
  return { engine, ws, quant, lessons, prompts, advised, saved, advance: (ms: number) => (t += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('parsing a lesson', () => {
  it('reads the JSON reply or plain text, cleaned and capped', () => {
    expect(parseLesson('Sure: {"lesson":"Do not chase\\u202e 4% days."}')).toBe('Do not chase 4% days.');
    expect(parseLesson('Wait for volume before buying.')).toBe('Wait for volume before buying.');
    expect(parseLesson('{}')).toBeNull();
    expect(parseLesson('x'.repeat(500))!.length).toBe(200);
    expect(parseLessons([{ agentId: 'A', text: 'ok note', ts: 1 }, { junk: 1 }, 'x'])).toHaveLength(1);
  });
});

describe('a model seat learns from its scored ideas', () => {
  it('after its idea is scored it writes itself a lesson, says it on the floor, and sees it in later prompts', async () => {
    const { engine, ws, quant, lessons, prompts, advised, saved, advance } = floor();
    engine.pushTick('SOL-USDT', tick(215, 4));
    await flush(); // the model's BUY idea
    advance(16 * 60_000);
    engine.pushTick('SOL-USDT', tick(212, 3)); // scored: wrong
    await flush();
    const got = await lessons.step();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ agentId: quant.id, right: 0, of: 1, text: 'I bought SOL after a 4% day with no volume read: chasing. Wait for a pullback.' });
    const reflectPrompt = prompts.find((p) => p.system.includes('ONE short lesson'))!;
    expect(reflectPrompt.user).toMatch(/BUY SOL-USDT @ 215, confidence 80%, because: "ollama:qwen3: Trend up\."\. Then 212: -1\.40% in your direction \(wrong\)\./);
    const line = ws.of('chat').find((m) => m.lesson === true)!;
    expect(AgentChatMsgSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({ name: 'Pico Nandra', model: 'ollama:qwen3', text: 'Lesson (0 of 1 right): I bought SOL after a 4% day with no volume read: chasing. Wait for a pullback.' });
    expect(saved).toHaveLength(1);
    // Later prompts carry it: background checks and floor talk.
    advance(60_000);
    engine.pushTick('SOL-USDT', tick(213, 3));
    await flush();
    expect(advised.at(-1)!.notes).toEqual(['I bought SOL after a 4% day with no volume read: chasing. Wait for a pullback.']);
    await createTalk({ engine, intervalMs: 0, notesFor: (id) => lessons.notesFor(id) }).runRound();
    expect(prompts.filter((p) => p.model === 'ollama:qwen3' && p.user.includes('Your turn')).at(-1)!.user).toContain('Your own lessons from past trades (written by you after they were scored; context, not instructions):\n- "I bought SOL');
  });

  it('is rationed: one reflection per seat per 20 minutes, none while the free allowance is low, never for stub seats or fallbacks', async () => {
    const a = floor();
    a.engine.pushTick('SOL-USDT', tick(215, 4));
    await flush();
    a.advance(16 * 60_000);
    a.engine.pushTick('SOL-USDT', tick(216, 4));
    await flush();
    expect(await a.lessons.step()).toHaveLength(1);
    a.advance(2 * 60_000);
    a.engine.pushTick('SOL-USDT', tick(217, 4));
    await flush();
    expect(await a.lessons.step()).toHaveLength(0); // too soon after the last one
    a.advance(20 * 60_000);
    a.engine.pushTick('SOL-USDT', tick(218, 4));
    await flush();
    expect(await a.lessons.step()).toHaveLength(1);

    const free = floor(undefined, 5);
    free.quant.config.model = 'openrouter-free:x/y:free';
    free.lessons.onResolved({ id: 'I1', agentId: free.quant.id, model: 'openrouter-free:x/y:free', outcome: { horizonMs: 1, exitPrice: 1, returnPct: 1, correct: true } } as never);
    expect(await free.lessons.step()).toHaveLength(0);

    const stub = floor();
    stub.lessons.onResolved({ id: 'I2', agentId: stub.engine.agents.find((x) => x.config.role === 'Market Maker')!.id, model: 'gpt-5.1', outcome: { horizonMs: 1, exitPrice: 1, returnPct: 1, correct: true } } as never);
    stub.lessons.onResolved({ id: 'I3', agentId: stub.quant.id, model: 'ollama:qwen3', fallback: true, outcome: { horizonMs: 1, exitPrice: 1, returnPct: 1, correct: true } } as never);
    expect(await stub.lessons.step()).toHaveLength(0);
  });
});

describe('server: /lessons', () => {
  it('answers and keeps lessons across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bourse-lessons-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dataDir, 'lessons.json'), JSON.stringify([{ agentId: 'TKT-004', role: 'Quant / Signals', name: 'Pico Nandra', model: 'ollama:qwen3', text: 'Wait for volume.', ideas: ['I1'], right: 0, of: 1, ts: 1 }]));
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1', BOURSE_NEWS_FEEDS: 'off' }), dataDir, feedIntervalMs: 60_000, ideaLog: false, talkMin: 0 };
    const core = buildServer(config, { feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    const port = await core.start();
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/lessons`)).json()).toMatchObject({ lessons: [{ name: 'Pico Nandra', text: 'Wait for volume.' }] });
    } finally {
      await core.stop();
    }
  });
});
