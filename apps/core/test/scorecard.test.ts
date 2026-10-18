import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentScorecardSchema } from 'shared';
import { loadConfig } from '../src/config';
import { createEngine, type FloorSocket } from '../src/engine';
import { createScorebook, type IdeaInput, type IdeaRecord } from '../src/scorecard';
import { buildServer } from '../src/server';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const seat = { agentId: 'TKT-001', role: 'Quant', name: 'Vega', model: 'stub' };
const idea = (over: Partial<IdeaInput> = {}): IdeaInput => ({
  ...seat, temperature: 0.2, autonomy: 'APPROVE', symbol: 'BTC-USDT', side: 'BUY', size: 0.01, confidence: 0.6,
  rationale: 'test', price: 100, change24h: 2, source: 'binance', ...over,
});

describe('scorebook: ideas', () => {
  it('scores an idea against the price at the horizon, not before', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 60_000 });
    sb.idea(idea({ side: 'BUY', price: 100 }));
    c.advance(59_000);
    expect(sb.tick('BTC-USDT', 110)).toHaveLength(0);
    c.advance(1_000);
    const [r] = sb.tick('BTC-USDT', 102);
    expect(r!.outcome).toEqual({ horizonMs: 60_000, exitPrice: 102, returnPct: 2, correct: true });
    expect(sb.tick('BTC-USDT', 50)).toHaveLength(0); // scored once only
  });

  it('a SELL is right when the price falls', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 1 });
    sb.idea(idea({ side: 'SELL', price: 100 }));
    c.advance(1);
    expect(sb.tick('BTC-USDT', 95)[0]!.outcome).toMatchObject({ returnPct: 5, correct: true });
    sb.idea(idea({ side: 'SELL', price: 100 }));
    c.advance(1);
    expect(sb.tick('BTC-USDT', 101)[0]!.outcome).toMatchObject({ returnPct: -1, correct: false });
  });

  it('only scores ideas on the symbol that ticked', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 1 });
    sb.idea(idea({ symbol: 'ETH-USDT' }));
    c.advance(5);
    expect(sb.tick('BTC-USDT', 120)).toHaveLength(0);
    expect(sb.tick('ETH-USDT', 120)).toHaveLength(1);
  });

  it('keeps hit rate and average return on the card', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 1 });
    sb.idea(idea({ side: 'BUY', price: 100 }));
    sb.idea(idea({ side: 'BUY', price: 100 }));
    sb.idea(idea({ side: 'SELL', price: 100 }));
    c.advance(1);
    sb.tick('BTC-USDT', 104);
    expect(sb.cardOf('TKT-001')).toMatchObject({ ideas: 3, scored: 3, hits: 2, avgReturnPct: 1.3333 });
    expect(sb.cardOf('TKT-001')!.hitRate).toBeCloseTo(2 / 3);
  });

  it('calls onResolved once per idea, and keeps the idea list bounded', () => {
    const c = clock();
    const seen: IdeaRecord[] = [];
    const sb = createScorebook({ now: c.now, horizonMs: 1, maxIdeas: 3, onResolved: (r) => seen.push(r) });
    for (let i = 0; i < 5; i++) sb.idea(idea());
    expect(sb.ideas()).toHaveLength(3);
    c.advance(1);
    sb.tick('BTC-USDT', 101);
    sb.tick('BTC-USDT', 101);
    expect(seen).toHaveLength(3);
  });

  it('ignores a bad price', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 1 });
    sb.idea(idea());
    c.advance(1);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(sb.tick('BTC-USDT', bad)).toHaveLength(0);
  });
});

describe('scorebook: trading record', () => {
  it('counts fills, closes and wins from realised P&L', () => {
    const sb = createScorebook();
    sb.fill(seat, 'BTC-USDT', 'BUY', 1, 100, 0);
    sb.fill(seat, 'BTC-USDT', 'SELL', 1, 110, 10);
    sb.fill(seat, 'BTC-USDT', 'BUY', 1, 110, 0);
    sb.fill(seat, 'BTC-USDT', 'SELL', 1, 105, -5);
    expect(sb.cardOf('TKT-001')).toMatchObject({ fills: 4, closes: 2, wins: 1, winRate: 0.5, realized: 5, notional: 425 });
  });

  it('tracks the worst drawdown from a P&L peak', () => {
    const sb = createScorebook();
    for (const p of [0, 50, 20, 80, 30, 60]) sb.mark(seat, p);
    expect(sb.cardOf('TKT-001')).toMatchObject({ pnl: 60, peakPnl: 80, maxDrawdown: 50 });
  });

  it('matches a fill to the newest open idea from the same seat, symbol and side', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now });
    sb.idea(idea({ side: 'BUY' }));
    sb.idea(idea({ side: 'SELL' }));
    sb.idea(idea({ side: 'BUY', symbol: 'ETH-USDT' }));
    sb.fill(seat, 'BTC-USDT', 'BUY', 1, 100, 0);
    expect(sb.ideas().map((r) => r.filled)).toEqual([true, false, false]);
  });

  it('does not match a fill to an idea from too long ago', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now });
    sb.idea(idea());
    c.advance(31 * 60_000);
    sb.fill(seat, 'BTC-USDT', 'BUY', 1, 100, 0);
    expect(sb.ideas()[0]!.filled).toBe(false);
  });
});

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  on() {
    return this;
  }
}

describe('engine scorecards', () => {
  it('records stub ideas, auto fills and HOLDs, and scores ideas at the horizon', () => {
    const c = clock();
    const engine = createEngine({ now: c.now, cooldownMs: 0, scoreHorizonMs: 60_000 });
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const trader = engine.scorecards().find((x) => x.role === 'Execution Trader')!;
    expect(trader.ideas).toBe(1);
    expect(trader.fills).toBe(1); // AUTO seat
    const ideas = engine.ideas();
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.every((r) => r.price === 100 && r.change24h === 3 && r.source === 'binance')).toBe(true);
    expect(ideas.find((r) => r.role === 'Execution Trader')!.filled).toBe(true);

    c.advance(60_000);
    engine.pushTick('BTC-USDT', { price: 101, change24h: 0, source: 'binance' }); // flat: everyone HOLDs this time
    const scored = engine.ideas().filter((r) => r.outcome);
    expect(scored.length).toBe(ideas.length);
    expect(scored.every((r) => r.outcome!.correct)).toBe(true);
    expect(engine.scorecards().find((x) => x.role === 'Execution Trader')).toMatchObject({ scored: 1, hits: 1, hitRate: 1 });
  });

  it('counts risk vetoes and operator-approved fills', () => {
    const c = clock();
    const engine = createEngine({ now: c.now, cooldownMs: 0 });
    engine.pushTick('ETH-USDT', { price: 10, change24h: 0, source: 'binance' });
    const quant = engine.agents.find((a) => a.config.role === 'Quant / Signals')!;
    engine.submitOrder(quant, 'ETH-USDT', 'BUY', 1, 'Approved by operator');
    engine.submitOrder(quant, 'ETH-USDT', 'BUY', 1_000_000, 'Approved by operator'); // over the clip
    expect(engine.scorecards().find((x) => x.agentId === quant.id)).toMatchObject({ fills: 1, vetoes: 1 });
  });

  it('sends every scorecard on connect, then only changed ones, at most every 2s per seat', () => {
    const c = clock();
    const engine = createEngine({ now: c.now, cooldownMs: 0 });
    const ws = new FakeSocket();
    engine.addClient(ws);
    const onConnect = ws.sent.filter((m) => m.type === 'scorecard');
    expect(onConnect).toHaveLength(engine.agents.length);
    for (const m of onConnect) expect(AgentScorecardSchema.safeParse(m).success).toBe(true);

    ws.sent.length = 0;
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    const first = ws.sent.filter((m) => m.type === 'scorecard').length;
    expect(first).toBeGreaterThan(0);
    ws.sent.length = 0;
    c.advance(500);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    expect(ws.sent.filter((m) => m.type === 'scorecard')).toHaveLength(0); // throttled
    c.advance(2_000);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });
    expect(ws.sent.filter((m) => m.type === 'scorecard').length).toBeGreaterThan(0);
  });

  it('gives guest agents a scorecard too', () => {
    const engine = createEngine();
    const g = engine.registerGuest('Claude Bot')!;
    expect(engine.scorecards().some((x) => x.agentId === g.id && x.role === 'Guest: Claude Bot')).toBe(true);
  });
});

describe('server: scorecards, export and the idea log', () => {
  it('serves scorecards and the JSONL export, and appends scored ideas to the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bourse-ideas-'));
    const engineLog: IdeaRecord[] = [];
    // A 60 ms horizon so the test can wait it out. Env parsing only allows whole minutes from 1; the config itself takes any value.
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, dataDir: dir, scoreHorizonMin: 0.001 };
    // Use the server's own engine (so its idea log is wired) and drive ticks directly.
    const core = buildServer(config, { feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    try {
      const port = await core.start();
      const base = `http://127.0.0.1:${port}`;
      core.engine.pushTick('BTC-USDT', { price: 100, change24h: 3, source: 'binance' });

      const sc = (await (await fetch(`${base}/scorecards`)).json()) as { horizonMs: number; scorecards: Array<{ role: string; ideas: number }> };
      expect(sc.horizonMs).toBe(60);
      expect(sc.scorecards.find((x) => x.role === 'Execution Trader')!.ideas).toBe(1);

      const res = await fetch(`${base}/export/ideas.jsonl`);
      expect(res.headers.get('content-type')).toContain('application/x-ndjson');
      expect(res.headers.get('content-disposition')).toContain('bourse-ideas.jsonl');
      const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as IdeaRecord);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatchObject({ symbol: 'BTC-USDT', price: 100, outcome: null });
      expect(await (await fetch(`${base}/export/ideas.jsonl?scored=1`)).text()).toBe('');

      await new Promise((r) => setTimeout(r, 80));
      core.engine.pushTick('BTC-USDT', { price: 103, change24h: 0, source: 'binance' });
      await core.stop(); // flushes the queued writes
      const logged = readFileSync(join(dir, 'ideas.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as IdeaRecord);
      engineLog.push(...logged);
      expect(logged.length).toBe(lines.length);
      expect(logged.every((r) => r.outcome && r.outcome.exitPrice === 103)).toBe(true);
    } finally {
      await core.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
    expect(engineLog.length).toBeGreaterThan(0);
  });

  it('BOURSE_IDEA_LOG=off disables the log, and the horizon is configurable', () => {
    expect(loadConfig({ BOURSE_IDEA_LOG: 'off' }).ideaLog).toBe(false);
    expect(loadConfig({}).ideaLog).toBe(true);
    expect(loadConfig({ BOURSE_SCORE_HORIZON_MIN: '60' }).scoreHorizonMin).toBe(60);
    expect(() => loadConfig({ BOURSE_SCORE_HORIZON_MIN: '0' })).toThrow();
  });
});
