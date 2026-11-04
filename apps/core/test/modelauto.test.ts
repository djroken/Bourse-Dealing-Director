import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIntentSchema } from 'shared';
import { createEngine, type FloorSocket } from '../src/engine';
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
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(modelAuto: boolean, reply = '{"side":"buy","confidence":0.8,"rationale":"Trend is up."}') {
  const advisor: Advisor = {
    handles: (id) => id.startsWith('ollama:'),
    advise: async () => ({ ok: true, view: JSON.parse(reply.replace('buy', 'BUY')) }),
    status: () => ({ ollama: { host: '', used: 0, cap: 0 }, openrouter: { keySet: false, used: 0, cap: 0 } }),
    converse: async () => ({ ok: true, text: '{"say":"SOL, buying a clip.","idea":{"symbol":"SOL-USDT","side":"BUY","confidence":0.8}}' }),
  };
  const engine = createEngine({ now: () => Date.UTC(2026, 10, 4, 21, 0), cooldownMs: 0, modelCooldownMs: 0, advisor, modelAuto });
  const ws = new FakeSocket();
  engine.addClient(ws);
  const quant = engine.agents.find((a) => a.config.role === 'Quant / Signals')!;
  quant.config.model = 'ollama:qwen3';
  quant.config.autonomy = 'AUTO';
  return { engine, ws, quant };
}

describe('model seats trading on paper by themselves', () => {
  it('off (the default): an AUTO model seat still only suggests', async () => {
    const { engine, ws, quant } = setup(false);
    engine.pushTick('SOL-USDT', tick(215, 4));
    await flush();
    const mine = ws.of('intent').filter((m) => m.agentId === quant.id && m.side !== 'HOLD');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.needsApproval === true)).toBe(true);
    expect(quant.book.positions.size).toBe(0);
  });
  it('on: the AUTO model seat\'s own idea fills on the paper book after the risk gate, and says so', async () => {
    const { engine, ws, quant } = setup(true);
    engine.pushTick('SOL-USDT', tick(215, 4));
    await flush();
    const intent = ws.of('intent').find((m) => m.agentId === quant.id && m.side === 'BUY')!;
    expect(AgentIntentSchema.safeParse(intent).success).toBe(true);
    expect(intent.needsApproval).toBe(false);
    const d = ws.of('decision').find((m) => m.agentId === quant.id)!;
    expect(d).toMatchObject({ action: 'BUY', riskChecked: true, rationale: 'AUTO on paper · ollama:qwen3 · within risk limits' });
    expect(d.venue).toBeUndefined(); // never a broker
    expect(quant.book.positions.get('SOL-USDT')!.qty).toBeGreaterThan(0);
    expect(engine.ideas().find((i) => i.agentId === quant.id && i.side === 'BUY')!.filled).toBe(true);
  });
  it('on, but SUGGEST or APPROVE seats still wait; HALT ALL stops it', async () => {
    const { engine, ws, quant } = setup(true);
    quant.config.autonomy = 'APPROVE';
    engine.pushTick('SOL-USDT', tick(215, 4));
    await flush();
    expect(quant.book.positions.size).toBe(0);
    expect(ws.of('intent').filter((m) => m.agentId === quant.id && m.side === 'BUY').every((m) => m.needsApproval === true)).toBe(true);
    quant.config.autonomy = 'AUTO';
    engine.haltAll();
    engine.pushTick('SOL-USDT', tick(216, 4));
    await flush();
    expect(quant.book.positions.size).toBe(0);
  });
  it('an idea from floor talk fills too when allowed, and the setting changes at runtime', async () => {
    const { engine, ws, quant } = setup(false);
    quant.config.model = 'ollama:quant';
    engine.pushTick('SOL-USDT', tick(215, 4));
    await flush();
    engine.setModelAuto(true);
    expect(engine.modelAuto()).toBe(true);
    await createTalk({ engine, now: () => Date.UTC(2026, 10, 4, 21, 0), intervalMs: 0 }).runRound();
    expect(ws.of('decision').some((m) => m.agentId === quant.id && /AUTO on paper · ollama:quant in floor talk/.test(String(m.rationale)))).toBe(true);
  });
});

describe('server: /floor/settings', () => {
  it('reads, changes (origin-guarded, validated) and remembers the setting across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bourse-set-'));
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1', BOURSE_NEWS_FEEDS: 'off' }), dataDir, feedIntervalMs: 60_000, ideaLog: false, talkMin: 0 };
    const deps = { feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } };
    let core = buildServer(config, deps);
    let port = await core.start();
    const url = () => `http://127.0.0.1:${port}/floor/settings`;
    try {
      expect(await (await fetch(url())).json()).toEqual({ modelAuto: false });
      const put = (body: unknown, origin?: string) => fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
      expect((await put({ modelAuto: true }, 'https://evil.example')).status).toBe(403);
      expect((await put({ modelAuto: 'yes' })).status).toBe(400);
      expect(await (await put({ modelAuto: true }, 'http://localhost:3000')).json()).toEqual({ modelAuto: true });
      expect(await (await fetch(`http://127.0.0.1:${port}/models`)).json()).toMatchObject({ modelAuto: true });
    } finally {
      await core.stop();
    }
    core = buildServer(config, deps);
    port = await core.start();
    try {
      expect(await (await fetch(url())).json()).toEqual({ modelAuto: true }); // remembered
    } finally {
      await core.stop();
    }
    expect(loadConfig({ BOURSE_MODEL_AUTO: 'paper' }).modelAuto).toBe(true);
    expect(loadConfig({ BOURSE_MODEL_AUTO: 'off' }).modelAuto).toBe(false);
    expect(loadConfig({}).modelAuto).toBeUndefined();
  });
});
