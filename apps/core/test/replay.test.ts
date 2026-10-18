import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import type { Advisor, MarketContext } from '../src/models';
import { createReplayRunner, fetchHistory, REPLAY_TF_MS, runReplay, type Candle, type ReplayParams, type ReplaySeat } from '../src/replay';
import { buildServer } from '../src/server';

const H = REPLAY_TF_MS['1h'];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
/** Hourly closes: `fn(i)` for candle i. */
const series = (n: number, fn: (i: number) => number): Candle[] => Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, c: fn(i) }));
const params = (over: Partial<ReplayParams> = {}): ReplayParams => ({ symbol: 'BTC-USDT', timeframe: '1h', days: 2, horizon: 2, feeBps: 0, maxModelCalls: 60, ...over });
const stub: ReplaySeat = { role: 'Execution Trader', name: 'Atlas', model: 'stub', temperature: 0, mandate: '', maxClip: 10_000, usesModel: false };
const modelSeat: ReplaySeat = { ...stub, role: 'Quant / Signals', name: 'Pico', model: 'ollama:test', usesModel: true };

function fakeAdvisor(decide: (ctx: MarketContext) => 'BUY' | 'SELL' | 'HOLD' | 'fail'): Advisor & { seen: MarketContext[] } {
  const seen: MarketContext[] = [];
  return {
    seen,
    handles: (id) => id.startsWith('ollama:'),
    advise: async (_id, ctx) => {
      seen.push(ctx);
      const d = decide(ctx);
      return d === 'fail' ? { ok: false, reason: 'down' } : { ok: true, view: { side: d, confidence: 0.8, rationale: `saw ${ctx.price}` } };
    },
    status: () => ({ ollama: { host: '', used: 0, cap: 0 }, openrouter: { keySet: false, used: 0, cap: 0 } }),
  };
}

describe('runReplay', () => {
  it('a rising market: the momentum stub buys, every idea is right, P&L is positive', async () => {
    const cs = series(24 + 48 + 2, (i) => 100 + i);
    const r = await runReplay(params(), [stub], cs, T0 + DAY);
    const s = r.seats[0]!;
    expect(s.evaluated).toBe(48);
    expect(s.ideas).toBe(48);
    expect(s.hitRate).toBe(1);
    expect(s.pnl).toBeGreaterThan(0);
    expect(s.maxDrawdown).toBe(0);
    expect(r.ideas.every((x) => x.side === 'BUY' && x.correct)).toBe(true);
    expect(r.marketReturnPct).toBeGreaterThan(0);
  });

  it('never looks ahead: the agent sees the close at i and a 24h change from candles up to i only', async () => {
    // Flat for the first 24h + 10 candles, then a jump. An agent with look-ahead would know about the jump early.
    const cs = series(24 + 48 + 2, (i) => (i < 34 ? 100 : 200));
    const adv = fakeAdvisor(() => 'HOLD');
    await runReplay(params({ maxModelCalls: 1000 }), [modelSeat], cs, T0 + DAY, { advisor: adv });
    expect(adv.seen).toHaveLength(48);
    for (const [k, ctx] of adv.seen.entries()) {
      const i = 24 + k;
      expect(ctx.price).toBe(cs[i]!.c);
      expect(ctx.change24h).toBeCloseTo(((cs[i]!.c - cs[i - 24]!.c) / cs[i - 24]!.c) * 100, 2);
    }
    expect(adv.seen[9]!.price).toBe(100); // candle 33: still flat, no hint of the jump at 34
  });

  it('scores against the close `horizon` candles later, net of fees on both sides', async () => {
    const cs = series(24 + 3 + 2, (i) => (i === 25 ? 110 : 100));
    const adv = fakeAdvisor((ctx) => (ctx.price === 100 ? 'SELL' : 'HOLD'));
    const r = await runReplay(params({ horizon: 1, feeBps: 10, days: 1 }), [modelSeat], cs, T0 + DAY, { advisor: adv });
    const first = r.ideas[0]!; // candle 24 at 100, exit candle 25 at 110: a SELL that was wrong
    expect(first).toMatchObject({ side: 'SELL', price: 100, exitPrice: 110, correct: false, returnPct: -10 });
    const size = first.size;
    expect(first.pnl).toBeCloseTo(-size * 10 - size * 100 * 0.001 - size * 110 * 0.001, 6);
  });

  it('counts a failed model call as failed, never substitutes the stub rule', async () => {
    const cs = series(24 + 10 + 2, (i) => 100 + i);
    const r = await runReplay(params({ days: 1, maxModelCalls: 1000 }), [modelSeat], cs, T0 + DAY, { advisor: fakeAdvisor(() => 'fail') });
    expect(r.seats[0]).toMatchObject({ failed: 10, ideas: 0, hitRate: null });
    const noAdvisor = await runReplay(params({ days: 1 }), [modelSeat], cs, T0 + DAY);
    expect(noAdvisor.seats[0]!.ideas).toBe(0);
  });

  it('samples model seats evenly to stay within maxModelCalls; stub seats see every candle', async () => {
    const cs = series(24 + 100 + 2, (i) => 100 + i);
    const adv = fakeAdvisor(() => 'BUY');
    const r = await runReplay(params({ days: 5, maxModelCalls: 10 }), [stub, modelSeat], cs, T0 + DAY, { advisor: adv });
    expect(adv.seen.length).toBeLessThanOrEqual(10);
    expect(r.seats.find((s) => s.role === 'Execution Trader')!.evaluated).toBe(100);
    expect(r.seats.find((s) => s.role === 'Quant / Signals')!.evaluated).toBe(adv.seen.length);
  });

  it('tracks drawdown on the equity curve and can be cancelled', async () => {
    // Always BUY, one candle each: +10, -10, -10, +10, +10. Equity 0 → 10 → 0 → -10 → 0 → 10: worst fall from a peak is 20 x size.
    const path = [100, 110, 100, 90, 100, 110];
    const cs = series(24 + path.length, (i) => (i < 24 ? 100 : path[i - 24]!));
    const adv = fakeAdvisor(() => 'BUY');
    const r = await runReplay(params({ horizon: 1, days: 1, maxModelCalls: 1000 }), [modelSeat], cs, T0 + DAY, { advisor: adv });
    expect(r.seats[0]!.ideas).toBe(5);
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (const t of r.ideas) {
      eq += t.pnl;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
    }
    expect(dd).toBeGreaterThan(0);
    expect(r.seats[0]!.maxDrawdown).toBeCloseTo(dd, 1);
    let n = 0;
    await expect(runReplay(params(), [stub], series(24 + 48 + 2, (i) => 100 + i), T0 + DAY, { isCancelled: () => ++n > 3 })).rejects.toThrow('cancelled');
  });
});

describe('fetchHistory', () => {
  it('pages through Binance klines and drops duplicates and bad rows', async () => {
    const calls: string[] = [];
    const fj = async (url: string) => {
      calls.push(url);
      const start = Number(new URL(url).searchParams.get('startTime'));
      if (start >= T0 + 3 * H) return [];
      return [[start, '0', '0', '0', String(100 + start / H)], [start + H, '0', '0', '0', 'x'], [start, '0', '0', '0', '5']];
    };
    const { candles, source } = await fetchHistory(fj, 'BTC-USDT', '1h', T0, T0 + 10 * H);
    expect(source).toBe('binance');
    expect(candles.map((c) => c.t)).toEqual([T0, T0 + H, T0 + 2 * H]); // the bad row at +H is replaced by the next page's good one
    expect(calls[0]).toContain('symbol=BTCUSDT&interval=1h');
  });
  it('falls back to Coinbase in 300-candle pages', async () => {
    const calls: string[] = [];
    const fj = async (url: string) => {
      calls.push(url);
      if (url.includes('binance')) throw new Error('blocked');
      const start = Date.parse(new URL(url).searchParams.get('start')!);
      return [[start / 1000 + 3600, 0, 0, 0, 101, 1], [start / 1000, 0, 0, 0, 100, 1]];
    };
    const { candles, source } = await fetchHistory(fj, 'ETH-USDT', '1h', T0, T0 + 600 * H);
    expect(source).toBe('coinbase');
    expect(calls.filter((c) => c.includes('coinbase'))).toHaveLength(2);
    expect(candles[0]).toEqual({ t: T0, c: 100 });
  });
  it('rejects an unknown symbol and fails when nothing answers', async () => {
    await expect(fetchHistory(async () => [], 'DOGE-USDT', '1h', T0, T0 + H)).rejects.toThrow(/unknown symbol/);
    await expect(fetchHistory(async () => { throw new Error('x'); }, 'BTC-USDT', '1h', T0, T0 + 10 * H)).rejects.toThrow(/no historical candles/);
  });
});

describe('replay runner and HTTP', () => {
  const klines = (now: number) => async (url: string) => {
    const u = new URL(url);
    const start = Number(u.searchParams.get('startTime'));
    const end = Math.min(Number(u.searchParams.get('endTime')), now);
    const rows: unknown[] = [];
    for (let t = start; t <= end && rows.length < 1000; t += H) rows.push([t, '0', '0', '0', String(100 + (t - T0) / H)]);
    return rows;
  };

  it('runs one job at a time and keeps the result', async () => {
    const now = T0 + 5 * DAY;
    const runner = createReplayRunner({ fetchJson: klines(now), now: () => now, seatsFor: () => [stub] });
    const job = runner.start(params({ days: 2 }));
    expect('id' in job).toBe(true);
    expect(runner.start(params())).toEqual({ error: 'a replay is already running' });
    const id = (job as { id: string }).id;
    for (let i = 0; i < 100 && runner.running(); i++) await new Promise((r) => setTimeout(r, 5));
    const done = runner.get(id)!;
    expect(done.status).toBe('done');
    expect(done.result!.seats[0]!.ideas).toBeGreaterThan(0);
    expect(done.result!.ideas).toEqual([]); // the job view leaves the idea list out; it has its own endpoint
    expect(runner.ideas(id)!.length).toBe(done.result!.seats[0]!.ideas);
  });

  it('over HTTP: validates the body, starts, reports, exports, and refuses other origins', async () => {
    const now = Date.now();
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, persist: false, ideaLog: false };
    const core = buildServer(config, { feedDeps: { now: () => now, fetchJson: async (url: string) => (url.includes('klines') ? klines(now)(url) : Promise.reject(new Error('offline'))) } });
    const port = await core.start();
    const base = `http://127.0.0.1:${port}`;
    const post = (body: unknown, origin = 'http://localhost:3000') => fetch(`${base}/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    try {
      expect((await post({ symbol: 'DOGE-USDT', timeframe: '1h', days: 1 })).status).toBe(400);
      expect((await post({ symbol: 'BTC-USDT', timeframe: '1h', days: 99 })).status).toBe(400);
      expect((await post({ symbol: 'BTC-USDT', timeframe: '1h', days: 1 }, 'https://evil.example')).status).toBe(403);
      const res = await post({ symbol: 'BTC-USDT', timeframe: '1h', days: 2, horizon: 2 });
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      let job: { status: string; result: { seats: Array<{ role: string; ideas: number }> } | null } = { status: 'fetching', result: null };
      for (let i = 0; i < 200 && (job.status === 'fetching' || job.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 10));
        job = (await (await fetch(`${base}/replay/${id}`)).json()) as typeof job;
      }
      expect(job.status).toBe('done');
      expect(job.result!.seats.map((s) => s.role).sort()).toEqual(['Execution Trader', 'Market Maker', 'Quant / Signals', 'Sentiment Desk']);
      const jsonl = await (await fetch(`${base}/replay/${id}/ideas.jsonl`)).text();
      expect(jsonl.trim().split('\n').length).toBe(job.result!.seats.reduce((n, s) => n + s.ideas, 0));
      expect(((await (await fetch(`${base}/replay`)).json()) as { job: { id: string } }).job.id).toBe(id);
      expect((await fetch(`${base}/replay/nope`)).status).toBe(404);
    } finally {
      await core.stop();
    }
  });
});

describe('labels', () => {
  it('a seat without a connected model is labelled as the stub rule', async () => {
    const cs = series(24 + 4 + 2, (i) => 100 + i);
    const r = await runReplay(params({ days: 1 }), [{ ...stub, model: 'gpt-5.1' }], cs, T0 + DAY);
    expect(r.seats[0]!.model).toBe('stub rule (gpt-5.1 not connected)');
    expect(r.ideas[0]!.model).toBe('stub rule (gpt-5.1 not connected)');
  });
});
