import { describe, expect, it } from 'vitest';
import { AgentDecisionSchema, AgentIntentSchema, AgentLifecycleSchema } from 'shared';
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
    expect(momentumIntent(4, 10).side).toBe('BUY');
    expect(momentumIntent(-4, 10).side).toBe('SELL');
    expect(momentumIntent(0, 10)).toMatchObject({ side: 'HOLD', size: 0 });
    expect(momentumIntent(null, 10)).toMatchObject({ side: 'HOLD', size: 0 });
  });
  it('never exceeds the clip and scales with confidence', () => {
    expect(momentumIntent(50, 10).size).toBeLessThanOrEqual(10);
    expect(momentumIntent(5, 10).size).toBeGreaterThan(momentumIntent(1, 10).size);
  });
  it('turns a rounded-down zero size into HOLD instead of a zero-size BUY', () => {
    expect(momentumIntent(0.01, 10)).toMatchObject({ side: 'HOLD', size: 0 });
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
    const schemas = { lifecycle: AgentLifecycleSchema, intent: AgentIntentSchema, decision: AgentDecisionSchema } as const;
    expect(ws.sent.length).toBeGreaterThan(30);
    for (const m of ws.sent) {
      const schema = schemas[m.type as keyof typeof schemas];
      expect(schema, `unknown message type ${String(m.type)}`).toBeDefined();
      const r = schema.safeParse(m);
      expect(r.success, JSON.stringify(m) + ' ' + (r.success ? '' : r.error.message)).toBe(true);
    }
  });
});
