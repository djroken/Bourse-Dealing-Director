import { describe, expect, it } from 'vitest';
import { AgentConfigMsgSchema, AgentDecisionSchema, AgentIntentSchema, AgentLifecycleSchema, AgentPnlSchema, AgentScorecardSchema, defaultAgents } from 'shared';
import { InboundSchema, createEngine, momentumIntent, type FloorSocket } from '../src/engine';

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private handlers: Record<string, Array<(d?: unknown) => void>> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  on(event: string, cb: (d?: unknown) => void) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  emit(event: string, data?: unknown) {
    for (const cb of this.handlers[event] ?? []) cb(data);
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const tick = (change24h: number | null = 3) => ({ price: 100, change24h, source: 'binance' });

function setup(cooldownMs = 15_000) {
  const c = clock();
  const engine = createEngine({ now: c.now, cooldownMs });
  const ws = new FakeSocket();
  engine.addClient(ws);
  ws.sent.length = 0; // drop the connect-time lifecycle snapshot
  return { c, engine, ws };
}

describe('momentumIntent', () => {
  it('buys positive momentum, sells negative, holds flat', () => {
    expect(momentumIntent(4, 1000, 100).side).toBe('BUY');
    expect(momentumIntent(-4, 1000, 100).side).toBe('SELL');
    expect(momentumIntent(0, 1000, 100)).toMatchObject({ side: 'HOLD', size: 0 });
    expect(momentumIntent(null, 1000, 100)).toMatchObject({ side: 'HOLD', size: 0 });
  });
  it('sizes in asset units but caps the order at the USD clip, at any price', () => {
    for (const price of [0.5, 3.7, 100, 3421.2, 96412.5]) {
      const { size } = momentumIntent(50, 1000, price);
      expect(size * price, `price ${price}`).toBeLessThanOrEqual(1000);
    }
    expect(momentumIntent(50, 1000, 100).size).toBeGreaterThan(0);
  });
  it('scales with confidence', () => {
    expect(momentumIntent(5, 1000, 100).size).toBeGreaterThan(momentumIntent(1, 1000, 100).size);
  });
  it('holds rather than emit a zero-size order, and on a bad price', () => {
    expect(momentumIntent(0.01, 1000, 96412)).toMatchObject({ side: 'HOLD', size: 0 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(momentumIntent(4, 1000, bad), String(bad)).toMatchObject({ side: 'HOLD', size: 0 });
  });
});

describe('connect', () => {
  it('sends every agent its current state to a new client', () => {
    const engine = createEngine();
    const ws = new FakeSocket();
    engine.addClient(ws);
    expect(ws.of('lifecycle')).toHaveLength(engine.agents.length);
    expect(ws.of('lifecycle').every((m) => m.status === 'running')).toBe(true);
  });
});

describe('evaluation', () => {
  it('emits an intent per trading seat for the ticked symbol only, and none for seats that never trade', () => {
    const { engine, ws } = setup();
    engine.pushTick('BTC-USDT', tick());
    const intents = ws.of('intent');
    expect(intents).toHaveLength(engine.agents.filter((a) => a.config.trades).length);
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.length).toBeLessThan(engine.agents.length);
    const nonTraders = new Set(engine.agents.filter((a) => !a.config.trades).map((a) => a.id));
    expect(intents.some((m) => nonTraders.has(String(m.agentId)))).toBe(false);
    expect(new Set(intents.map((m) => m.symbol))).toEqual(new Set(['BTC-USDT']));
  });

  it('ignores symbols the floor does not trade (FX)', () => {
    const { engine, ws } = setup();
    engine.pushTick('USD-EUR', tick());
    expect(ws.sent).toHaveLength(0);
  });

  it('throttles repeat ticks per agent+symbol, then allows them after the cooldown', () => {
    const { c, engine, ws } = setup(15_000);
    engine.pushTick('BTC-USDT', tick());
    const first = ws.of('intent').length;
    c.advance(5_000);
    engine.pushTick('BTC-USDT', tick());
    expect(ws.of('intent')).toHaveLength(first); // inside cooldown
    engine.pushTick('ETH-USDT', tick()); // a different symbol is independent
    expect(ws.of('intent').length).toBe(first * 2);
    c.advance(10_001);
    engine.pushTick('BTC-USDT', tick());
    expect(ws.of('intent').length).toBe(first * 3);
  });

  it('only AUTO agents produce decisions; SUGGEST/APPROVE stop at the intent', () => {
    const { engine, ws } = setup();
    engine.pushTick('BTC-USDT', tick(4));
    const autoIds = engine.agents.filter((a) => a.config.autonomy === 'AUTO').map((a) => a.id).sort();
    expect(ws.of('decision').map((m) => m.agentId).sort()).toEqual(autoIds);
    expect(autoIds.length).toBeGreaterThan(0);
    expect(autoIds.length).toBeLessThan(engine.agents.length);
  });

  it('does not decide on HOLD', () => {
    const { engine, ws } = setup();
    engine.pushTick('BTC-USDT', tick(0));
    expect(ws.of('decision')).toHaveLength(0);
  });
});

describe('risk gate', () => {
  it('approves an AUTO decision inside the loss stop', () => {
    const { engine, ws } = setup();
    engine.pushTick('BTC-USDT', tick(4));
    const d = ws.of('decision')[0]!;
    expect(d).toMatchObject({ riskChecked: true, action: 'BUY' });
    expect(Number(d.size)).toBeGreaterThan(0);
  });

  it('vetoes (HOLD, size 0, riskChecked false) once an agent has hit its daily loss stop', () => {
    const { engine, ws } = setup();
    const auto = engine.agents.find((a) => a.config.autonomy === 'AUTO')!;
    engine.setDailyPnL(auto.id, -auto.config.riskLimits.dailyLossStop - 1);
    engine.pushTick('BTC-USDT', tick(4));
    const d = ws.of('decision').find((m) => m.agentId === auto.id)!;
    expect(d).toMatchObject({ riskChecked: false, action: 'HOLD', size: 0 });
    // other agents are unaffected
    const other = ws.of('decision').find((m) => m.agentId !== auto.id)!;
    expect(other.riskChecked).toBe(true);
  });

  it('keeps trading when an agent is deep in profit (old check vetoed or ignored this incorrectly)', () => {
    const { engine, ws } = setup();
    const auto = engine.agents.find((a) => a.config.autonomy === 'AUTO')!;
    engine.setDailyPnL(auto.id, auto.config.riskLimits.dailyLossStop * 10);
    engine.pushTick('BTC-USDT', tick(4));
    expect(ws.of('decision').find((m) => m.agentId === auto.id)).toMatchObject({ riskChecked: true });
  });
});

describe('halt / resume', () => {
  it('halt stops evaluation and announces it; resume restores it', () => {
    const { engine, ws, c } = setup(0);
    expect(engine.haltAll()).toBe(engine.agents.length);
    expect(ws.of('lifecycle').at(-1)).toMatchObject({ agentId: '*', status: 'halted' });
    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', tick());
    expect(ws.sent).toHaveLength(0);

    engine.resumeAll();
    expect(engine.agents.every((a) => a.state === 'running')).toBe(true);
    ws.sent.length = 0;
    c.advance(1);
    engine.pushTick('BTC-USDT', tick());
    expect(ws.of('intent').length).toBeGreaterThan(0);
  });
});

describe('client protocol', () => {
  it('subscription filters broadcasts to the chosen agents (floor-wide messages always pass)', () => {
    const { engine, ws } = setup();
    ws.emit('message', JSON.stringify({ type: 'subscribe', agentId: 'TKT-002' })); // `subscribe` omitted = true
    engine.pushTick('BTC-USDT', tick());
    expect(new Set(ws.of('intent').map((m) => m.agentId))).toEqual(new Set(['TKT-002']));
    ws.sent.length = 0;
    engine.haltAll();
    expect(ws.sent.some((m) => m.agentId === '*')).toBe(true);
    expect(ws.sent.some((m) => m.agentId === 'TKT-005')).toBe(false);
  });

  it('can unsubscribe again', () => {
    const { engine, ws } = setup();
    ws.emit('message', JSON.stringify({ type: 'subscribe', agentId: 'TKT-002' }));
    ws.emit('message', JSON.stringify({ type: 'subscribe', agentId: 'TKT-002', subscribe: false }));
    engine.pushTick('BTC-USDT', tick());
    expect(ws.of('intent')).toHaveLength(engine.agents.filter((a) => a.config.trades).length);
  });

  it('halt_all and resume_all work over the socket', () => {
    const { engine, ws } = setup();
    ws.emit('message', JSON.stringify({ type: 'halt_all' }));
    expect(engine.agents.every((a) => a.state === 'halted')).toBe(true);
    ws.emit('message', JSON.stringify({ type: 'resume_all' }));
    expect(engine.agents.every((a) => a.state === 'running')).toBe(true);
  });

  it('drops invalid JSON and unsupported messages without crashing or changing state', () => {
    const { engine, ws } = setup();
    for (const bad of ['not json', '{}', '{"type":"intent","agentId":"x"}', '{"type":"subscribe"}', '{"type":"subscribe","agentId":""}', 'null', '[]']) {
      expect(() => ws.emit('message', bad)).not.toThrow();
    }
    expect(engine.agents.every((a) => a.state === 'running')).toBe(true);
  });

  it('removes a client on close and does not write to a closed socket', () => {
    const { engine, ws } = setup();
    expect(engine.clientCount()).toBe(1);
    ws.readyState = 3;
    engine.pushTick('BTC-USDT', tick());
    expect(ws.sent).toHaveLength(0);
    ws.emit('close');
    expect(engine.clientCount()).toBe(0);
  });
});

describe('InboundSchema', () => {
  it('defaults subscribe to true and caps agentId length', () => {
    expect(InboundSchema.parse({ type: 'subscribe', agentId: 'TKT-001' })).toEqual({ type: 'subscribe', agentId: 'TKT-001', subscribe: true });
    expect(InboundSchema.safeParse({ type: 'subscribe', agentId: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('contract with packages/shared', () => {
  it('every message the engine emits parses against the shared schemas', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', tick(4));
    engine.pushTick('ETH-USDT', tick(-3));
    const auto = engine.agents.find((a) => a.config.autonomy === 'AUTO')!;
    engine.setDailyPnL(auto.id, -1e9); // exercise the veto shape too
    engine.pushTick('SOL-USDT', tick(2));
    engine.haltAll();
    engine.resumeAll();
    const schemas = { lifecycle: AgentLifecycleSchema, intent: AgentIntentSchema, decision: AgentDecisionSchema, pnl: AgentPnlSchema, config: AgentConfigMsgSchema, scorecard: AgentScorecardSchema } as const;
    expect(ws.sent.length).toBeGreaterThan(30);
    for (const m of ws.sent) {
      const schema = schemas[m.type as keyof typeof schemas];
      expect(schema, `unknown message type ${String(m.type)}`).toBeDefined();
      const r = schema.safeParse(m);
      expect(r.success, JSON.stringify(m) + ' ' + (r.success ? '' : r.error.message)).toBe(true);
    }
  });
});

describe('paper book and P&L', () => {
  const atlas = (engine: ReturnType<typeof createEngine>) => engine.agents.find((a) => a.config.role === 'Execution Trader')!;
  const last = (ws: FakeSocket, id: string) => ws.of('pnl').filter((m) => m.agentId === id).at(-1)!;

  it('a filled decision opens a position, and the pnl message matches the shared schema', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const m = last(ws, atlas(engine).id);
    expect(() => AgentPnlSchema.parse(m)).not.toThrow();
    expect(m.positions).toEqual([{ symbol: 'BTC-USDT', qty: expect.any(Number), avgPx: 100 }]);
    expect(m.pnl).toBe(0);
    expect(m.exposure).toBeGreaterThan(0);
  });
  it('marks to market as the price moves: long gains when price rises, and the loss stop reads it', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const qty = (last(ws, atlas(engine).id).positions as Array<{ qty: number }>)[0]!.qty;
    expect(qty).toBeGreaterThan(0);
    engine.pushTick('BTC-USDT', { price: 110, change24h: 0, source: 'binance' }); // flat momentum: no new trade
    expect(last(ws, atlas(engine).id).pnl).toBeCloseTo(qty * 10, 6);
    expect(atlas(engine).dailyPnL).toBeCloseTo(qty * 10, 6);
  });
  it('a seat that loses past its stop is vetoed, with no further fills', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 4, source: 'binance' }); // buys
    engine.pushTick('BTC-USDT', { price: 40, change24h: 4, source: 'binance' }); // price collapses: unrealised loss >> $500 stop
    expect(atlas(engine).dailyPnL).toBeLessThan(-atlas(engine).config.riskLimits.dailyLossStop);
    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', { price: 40, change24h: 4, source: 'binance' });
    const d = ws.of('decision').filter((m) => m.agentId === atlas(engine).id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: 'HOLD', size: 0, riskChecked: false });
    expect(Number(last(ws, atlas(engine).id).pnl)).toBeLessThan(0);
  });
  it('halting stops decisions but positions keep marking', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    engine.haltAll();
    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', { price: 90, change24h: 3, source: 'binance' });
    expect(ws.of('decision')).toHaveLength(0);
    expect(last(ws, atlas(engine).id).pnl).toBeLessThan(0);
  });
  it('seats that never trade never get a book', () => {
    const { engine, ws } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const nonTraders = new Set(engine.agents.filter((a) => !a.config.trades).map((a) => a.id));
    expect(ws.of('pnl').some((m) => nonTraders.has(String(m.agentId)))).toBe(false);
  });
  it('a client that connects later is told the current books straight away', () => {
    const { engine } = setup(0);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const late = new FakeSocket();
    engine.addClient(late);
    expect(late.of('pnl').length).toBeGreaterThan(0);
  });
});

describe('operator orders (place_order)', () => {
  const order = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'place_order', role: 'Quant / Signals', symbol: 'BTC-USDT', side: 'BUY', size: 1, ...over });
  const prime = () => {
    const s = setup(0);
    s.engine.pushTick('BTC-USDT', { price: 100, change24h: 0, source: 'binance' }); // flat: gives core a price, no agent trades
    s.ws.sent.length = 0;
    return s;
  };
  const quant = (engine: ReturnType<typeof createEngine>) => engine.agents.find((a) => a.config.role === 'Quant / Signals')!;

  it('fills at core\'s last price, checks risk, and reports the new book', () => {
    const { engine, ws } = prime();
    ws.emit('message', order({ size: 5 }));
    expect(ws.of('decision')).toHaveLength(1);
    expect(ws.of('decision')[0]).toMatchObject({ action: 'BUY', size: 5, price: 100, riskChecked: true });
    expect(ws.of('pnl').at(-1)).toMatchObject({ agentId: quant(engine).id, exposure: 500 });
    expect(() => AgentDecisionSchema.parse(ws.of('decision')[0])).not.toThrow();
  });
  it('matches the seat by role regardless of case and spacing (the Desk sends capitals)', () => {
    const { ws } = prime();
    ws.emit('message', order({ role: 'QUANT  /  SIGNALS', size: 1 }));
    expect(ws.of('decision')[0]).toMatchObject({ action: 'BUY', riskChecked: true });
  });
  it('refuses, and does not clamp, an order over the clip', () => {
    const { engine, ws } = prime();
    const clip = quant(engine).config.riskLimits.maxClip;
    ws.emit('message', order({ size: clip / 100 + 1 }));
    expect(ws.of('decision')[0]).toMatchObject({ action: 'HOLD', size: 0, riskChecked: false });
    expect(quant(engine).book.positions.size).toBe(0);
  });
  it('refuses when halted, with no price, or past the loss stop', () => {
    const a = prime();
    a.engine.haltAll();
    a.ws.sent.length = 0;
    a.ws.emit('message', order());
    expect(a.ws.of('decision')[0]).toMatchObject({ action: 'HOLD', riskChecked: false });

    const b = prime();
    b.ws.emit('message', order({ symbol: 'ETH-USDT' })); // never priced
    expect(b.ws.of('decision')[0]).toMatchObject({ action: 'HOLD', riskChecked: false });

    const c = prime();
    c.engine.setDailyPnL(quant(c.engine).id, -1e9);
    c.ws.emit('message', order());
    expect(c.ws.of('decision')[0]).toMatchObject({ action: 'HOLD', riskChecked: false });
    expect(quant(c.engine).book.positions.size).toBe(0);
  });
  it('ignores seats that never trade and malformed orders', () => {
    const { ws } = prime();
    ws.emit('message', order({ role: 'Risk Officer' }));
    for (const bad of [{ size: -1 }, { size: 0 }, { symbol: 'DOGE-USDT' }, { side: 'HOLD' }, { size: 'lots' }]) ws.emit('message', order(bad));
    expect(ws.sent).toHaveLength(0);
  });
});

describe('configure_agent', () => {
  const cfg = (over: Record<string, unknown>) => JSON.stringify({ type: 'configure_agent', role: 'Quant / Signals', ...over });
  const quant = (e: ReturnType<typeof createEngine>) => e.agents.find((a) => a.config.role === 'Quant / Signals')!;

  it('sends every seat its settings on connect, matching the shared schema', () => {
    const engine = createEngine();
    const ws = new FakeSocket();
    engine.addClient(ws);
    expect(ws.of('config')).toHaveLength(engine.agents.length);
    for (const m of ws.of('config')) expect(() => AgentConfigMsgSchema.parse(m)).not.toThrow();
  });
  it('changes autonomy, model, temperature and mandate, and tells everyone', () => {
    const { engine, ws } = setup(0);
    ws.emit('message', cfg({ autonomy: 'AUTO', model: 'qwen3 (ollama, local)', temperature: 0.7, mandate: 'Be careful.' }));
    expect(quant(engine).config).toMatchObject({ autonomy: 'AUTO', model: 'qwen3 (ollama, local)', temperature: 0.7, mandate: 'Be careful.' });
    expect(ws.of('config').at(-1)).toMatchObject({ role: 'Quant / Signals', autonomy: 'AUTO', mandate: 'Be careful.' });
  });
  it('a seat switched to AUTO then decides on its own', () => {
    const { engine, ws } = setup(0);
    ws.emit('message', cfg({ autonomy: 'AUTO' }));
    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', tick(4));
    expect(ws.of('decision').some((m) => m.agentId === quant(engine).id)).toBe(true);
  });
  it('never mutates the shared seed roster', () => {
    const before = JSON.stringify(defaultAgents);
    const { ws } = setup(0);
    ws.emit('message', cfg({ autonomy: 'AUTO', mandate: 'changed' }));
    expect(JSON.stringify(defaultAgents)).toBe(before);
  });
  it('pauses one seat without touching the others, and resumes it', () => {
    const { engine, ws } = setup(0);
    ws.emit('message', cfg({ paused: true }));
    expect(quant(engine).state).toBe('paused');
    expect(engine.agents.filter((a) => a.state === 'paused')).toHaveLength(1);
    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', tick(4));
    expect(ws.of('intent').some((m) => m.agentId === quant(engine).id)).toBe(false);
    ws.emit('message', cfg({ paused: false }));
    expect(quant(engine).state).toBe('running');
  });
  it('HALT ALL beats a single-seat resume, and RESUME ALL does not undo a seat you paused', () => {
    const { engine, ws } = setup(0);
    engine.haltAll();
    ws.emit('message', cfg({ paused: false }));
    expect(quant(engine).state).toBe('halted');
    ws.emit('message', cfg({ paused: true }));
    engine.resumeAll();
    expect(quant(engine).state).toBe('paused');
    expect(engine.agents.filter((a) => a.state === 'running')).toHaveLength(engine.agents.length - 1);
  });
  it('ignores unknown seats and invalid values, and cannot change risk limits', () => {
    const { engine, ws } = setup(0);
    const limits = JSON.stringify(quant(engine).config.riskLimits);
    ws.emit('message', cfg({ role: 'Janitor', autonomy: 'AUTO' }));
    for (const bad of [{ autonomy: 'YOLO' }, { temperature: 9 }, { model: '' }, { mandate: 'x'.repeat(2001) }, { paused: 'yes' }]) ws.emit('message', cfg(bad));
    ws.emit('message', cfg({ riskLimits: { maxClip: 1e9 }, maxClip: 1e9 }));
    expect(JSON.stringify(quant(engine).config.riskLimits)).toBe(limits);
    expect(quant(engine).config.autonomy).toBe('SUGGEST');
    expect(ws.of('config')).toHaveLength(1); // only the last (valid, harmless) message echoed
  });
});

describe('model seats', () => {
  const view = (side: 'BUY' | 'SELL' | 'HOLD', confidence = 0.8) => ({ ok: true as const, view: { side, confidence, rationale: 'because' } });
  function modelSetup(advise: (id: string) => Promise<any>) {
    const calls: string[] = [];
    const advisor = {
      handles: (id: string) => id.startsWith('ollama:'),
      advise: async (id: string) => { calls.push(id); return advise(id); },
      status: () => ({}) as any,
    };
    const c = clock();
    const engine = createEngine({ now: c.now, cooldownMs: 0, modelCooldownMs: 1000, advisor });
    const ws = new FakeSocket();
    engine.addClient(ws);
    ws.sent.length = 0;
    engine.agents[3]!.config.model = 'ollama:llama3.2'; // Pico, a trading seat
    return { c, engine, ws, calls };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('uses the model view, sized by core, and never auto-fills even on AUTO', async () => {
    const { engine, ws } = modelSetup(async () => view('BUY', 0.8));
    engine.agents[3]!.config.autonomy = 'AUTO';
    engine.pushTick('BTC-USDT', tick());
    await flush();
    const pico = ws.of('intent').filter((m) => m.agentId === 'TKT-004');
    expect(pico).toHaveLength(1);
    expect(pico[0]).toMatchObject({ side: 'BUY', confidence: 0.8 });
    expect(String(pico[0]!.rationale)).toContain('ollama:llama3.2: because');
    expect((pico[0]!.size as number) * 100).toBeLessThanOrEqual(engine.agents[3]!.config.riskLimits.maxClip);
    expect(ws.of('decision').filter((m) => m.agentId === 'TKT-004')).toHaveLength(0);
    expect(AgentIntentSchema.safeParse(pico[0]).success).toBe(true);
  });

  it('falls back to the stub rule, labelled, when the model fails; still never fills', async () => {
    const { engine, ws } = modelSetup(async () => ({ ok: false, reason: 'ECONNREFUSED' }));
    engine.agents[3]!.config.autonomy = 'AUTO';
    engine.pushTick('BTC-USDT', tick());
    await flush();
    const pico = ws.of('intent').filter((m) => m.agentId === 'TKT-004');
    expect(String(pico[0]!.rationale)).toContain('unavailable (ECONNREFUSED)');
    expect(ws.of('decision').filter((m) => m.agentId === 'TKT-004')).toHaveLength(0);
    // The stub rule made this idea, so the record says so: the model league won't credit it to the model.
    const rec = engine.ideas().filter((i) => i.agentId === 'TKT-004').at(-1);
    expect(rec?.fallback).toBe(true);
  });

  it('a seat on a free OpenRouter model makes no background calls (it saves the allowance for floor talk) unless allowed', async () => {
    const mk = (freeBackground: boolean) => {
      const calls: string[] = [];
      const advisor = { handles: (id: string) => id.startsWith('openrouter'), advise: async (id: string) => (calls.push(id), view('BUY')), status: () => ({}) as any };
      const engine = createEngine({ cooldownMs: 0, modelCooldownMs: 0, advisor, freeBackground });
      engine.agents.find((a) => a.config.role === 'Quant / Signals')!.config.model = 'openrouter-free:meta-llama/llama-3.3-70b-instruct:free';
      engine.agents.find((a) => a.config.role === 'Market Maker')!.config.model = 'openrouter:anthropic/claude-sonnet-4.5';
      engine.pushTick('BTC-USDT', tick());
      return calls;
    };
    expect(mk(false)).toEqual(['openrouter:anthropic/claude-sonnet-4.5']);
    expect(mk(true).sort()).toEqual(['openrouter-free:meta-llama/llama-3.3-70b-instruct:free', 'openrouter:anthropic/claude-sonnet-4.5']);
  });

  it('rate-limits model calls per seat and symbol, and never overlaps them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, engine, calls } = modelSetup(async () => { await gate; return view('HOLD'); });
    engine.pushTick('BTC-USDT', tick());
    engine.pushTick('BTC-USDT', tick()); // in flight and inside the cooldown
    expect(calls).toHaveLength(1);
    release();
    await flush();
    engine.pushTick('BTC-USDT', tick());
    expect(calls).toHaveLength(1); // still inside modelCooldownMs
    c.advance(1500);
    engine.pushTick('BTC-USDT', tick());
    expect(calls).toHaveLength(2);
  });

  it('drops a reply that arrives after the floor was halted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { engine, ws } = modelSetup(async () => { await gate; return view('BUY'); });
    engine.pushTick('BTC-USDT', tick());
    engine.haltAll();
    release();
    await flush();
    expect(ws.of('intent').filter((m) => m.agentId === 'TKT-004')).toHaveLength(0);
  });

  it('seats with a plain model id keep using the stub rule', async () => {
    const { engine, ws, calls } = modelSetup(async () => view('BUY'));
    engine.pushTick('BTC-USDT', tick());
    await flush();
    expect(calls).toEqual(['ollama:llama3.2']); // only Pico
    expect(ws.of('intent').filter((m) => m.agentId === 'TKT-002')).toHaveLength(1);
  });
});
