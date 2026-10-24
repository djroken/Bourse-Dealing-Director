import { CRYPTO, type CryptoFeed } from './feeds';
import { momentumIntent, sizeIntent } from './engine';
import type { Advisor, MarketContext } from './models';

/**
 * Replay: run seats over past candles and score every idea, in minutes instead of days.
 *
 * Honesty rules, enforced here rather than in the prompt:
 *  - No look-ahead. At candle i an agent sees only the close of candle i and the 24h change computed from candles
 *    up to i. The outcome is the close `horizon` candles later, read only after the decision is made.
 *  - Every idea is a fixed-horizon paper trade: enter at the close it was made on, exit `horizon` candles later,
 *    sized the way core sizes live intents, minus fees on both sides. No compounding, no overlap limits.
 *  - A model that fails or times out is counted as failed, never replaced by the stub rule, so a model's numbers
 *    are only ever the model's.
 */

export type ReplayTf = '1m' | '5m' | '15m' | '1h';
export const REPLAY_TF_MS: Record<ReplayTf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
const CB_GRAN: Record<ReplayTf, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
const DAY = 86_400_000;
/** Hard cap on candles in one replay (30 days of 1m is 43,200). */
export const MAX_REPLAY_CANDLES = 50_000;

export interface Candle {
  t: number;
  c: number;
}

export interface ReplaySeat {
  role: string;
  name: string;
  model: string;
  temperature: number;
  mandate: string;
  maxClip: number;
  /** True when this seat's model id is handled by an adapter (ollama:/openrouter:...). */
  usesModel: boolean;
}

export interface ReplayParams {
  symbol: string;
  timeframe: ReplayTf;
  days: number;
  /** Candles between an idea and its outcome. */
  horizon: number;
  /** Fee per side in basis points (5 = 0.05%). */
  feeBps: number;
  /** Most model calls per seat; the seat is sampled evenly across the period to stay within it. */
  maxModelCalls: number;
}

export interface ReplayIdea {
  ts: number;
  role: string;
  name: string;
  model: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  size: number;
  confidence: number;
  rationale: string;
  price: number;
  change24h: number | null;
  exitTs: number;
  exitPrice: number;
  returnPct: number;
  correct: boolean;
  /** USD, after fees on entry and exit. */
  pnl: number;
}

export interface SeatResult {
  role: string;
  name: string;
  model: string;
  /** Candles the seat was asked about. */
  evaluated: number;
  ideas: number;
  holds: number;
  /** Model calls that failed or returned something unusable. */
  failed: number;
  hits: number;
  hitRate: number | null;
  avgReturnPct: number | null;
  /** Net of fees, USD. */
  pnl: number;
  fees: number;
  wins: number;
  winRate: number | null;
  maxDrawdown: number;
  bestPct: number | null;
  worstPct: number | null;
}

export interface ReplayResult {
  from: number;
  to: number;
  candles: number;
  source: string;
  /** What simply holding the symbol over the replay window returned, for context. */
  marketReturnPct: number;
  seats: SeatResult[];
  ideas: ReplayIdea[];
}

// ---- candles ---------------------------------------------------------------------------------------------------

type FetchJson = (url: string) => Promise<unknown>;

const BINANCE = 'https://data-api.binance.vision/api/v3/klines';
const COINBASE = 'https://api.exchange.coinbase.com/products';

/** Closes from `from` to `to` (ms), oldest first, de-duplicated. Binance first, Coinbase if Binance won't answer. */
export async function fetchHistory(
  fetchJson: FetchJson,
  symbol: string,
  tf: ReplayTf,
  from: number,
  to: number,
  isCancelled: () => boolean = () => false,
  feeds: CryptoFeed[] = CRYPTO,
): Promise<{ candles: Candle[]; source: 'binance' | 'coinbase' }> {
  const meta = feeds.find((c) => c.display === symbol);
  if (!meta) throw new Error(`unknown symbol ${symbol}`);
  const step = REPLAY_TF_MS[tf];
  const clean = (cs: Candle[]) => {
    const seen = new Set<number>();
    return cs
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0 && c.t >= from && c.t < to && !seen.has(c.t) && (seen.add(c.t), true))
      .sort((a, b) => a.t - b.t)
      .slice(0, MAX_REPLAY_CANDLES);
  };

  try {
    const out: Candle[] = [];
    for (let start = from; start < to && out.length < MAX_REPLAY_CANDLES; ) {
      if (isCancelled()) throw new Error('cancelled');
      const rows = await fetchJson(`${BINANCE}?symbol=${meta.binance}&interval=${tf}&startTime=${start}&endTime=${to - 1}&limit=1000`);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) if (Array.isArray(r)) out.push({ t: Number(r[0]), c: Number(r[4]) });
      const last = Number((rows[rows.length - 1] as unknown[])[0]);
      if (!Number.isFinite(last) || last + step <= start) break;
      start = last + step;
    }
    const cs = clean(out);
    if (cs.length) return { candles: cs, source: 'binance' };
    throw new Error('no candles from binance');
  } catch (err) {
    if (err instanceof Error && err.message === 'cancelled') throw err;
    if (!meta.coinbase) throw new Error('no historical candles from Binance, and this coin has no Coinbase market');
    const out: Candle[] = [];
    const span = 300 * step; // Coinbase returns at most 300 candles per request
    try {
      for (let start = from; start < to && out.length < MAX_REPLAY_CANDLES; start += span) {
        if (isCancelled()) throw new Error('cancelled');
        const end = Math.min(to, start + span);
        const rows = await fetchJson(`${COINBASE}/${meta.coinbase}/candles?granularity=${CB_GRAN[tf]}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
        if (!Array.isArray(rows)) continue;
        for (const r of rows) if (Array.isArray(r)) out.push({ t: Number(r[0]) * 1000, c: Number(r[4]) });
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') throw e;
      throw new Error('no historical candles from Binance or Coinbase');
    }
    const cs = clean(out);
    if (!cs.length) throw new Error('no historical candles from Binance or Coinbase');
    return { candles: cs, source: 'coinbase' };
  }
}

// ---- the replay itself -----------------------------------------------------------------------------------------

export interface RunOptions {
  advisor?: Advisor;
  /** Called now and then with progress in 0..1. */
  onProgress?: (p: number) => void;
  isCancelled?: () => boolean;
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Run seats over candles. `candles` must include at least 24h of warm-up before `startTs` so the first evaluated
 * candle has a 24h change; candles before `startTs` are only ever used as history.
 */
export async function runReplay(params: ReplayParams, seats: ReplaySeat[], candles: Candle[], startTs: number, opts: RunOptions = {}): Promise<Omit<ReplayResult, 'source'>> {
  // For each candle, the newest candle at least 24h older: "24h ago" by the clock, which also works for stocks,
  // whose candles stop overnight and at weekends.
  const backIdx: number[] = new Array(candles.length).fill(-1);
  for (let i = 0, b = -1; i < candles.length; i++) {
    while (b + 1 < i && candles[b + 1]!.t <= candles[i]!.t - DAY) b++;
    backIdx[i] = b >= 0 && candles[b]!.t <= candles[i]!.t - DAY ? b : -1;
  }
  let first = candles.findIndex((c, i) => c.t >= startTs && backIdx[i]! >= 0);
  if (first < 0) first = candles.length;
  const last = candles.length - 1 - params.horizon; // the last candle whose outcome is known
  const evalIdx: number[] = [];
  for (let i = first; i <= last; i++) evalIdx.push(i);
  const fee = params.feeBps / 10_000;

  const results: SeatResult[] = [];
  const ideas: ReplayIdea[] = [];
  const totalWork = Math.max(1, seats.reduce((n, s) => n + (s.usesModel ? Math.min(evalIdx.length, params.maxModelCalls) : evalIdx.length), 0));
  let done = 0;

  for (const seat of seats) {
    // Model seats are sampled evenly so a long replay stays within maxModelCalls; stub seats see every candle.
    const stride = seat.usesModel ? Math.max(1, Math.ceil(evalIdx.length / Math.max(1, params.maxModelCalls))) : 1;
    // A seat whose model isn't connected runs the stub rule: say so, rather than credit the model with the stub's numbers.
    const label = seat.usesModel ? seat.model : `stub rule (${seat.model} not connected)`.slice(0, 96);
    const r: SeatResult = {
      role: seat.role, name: seat.name, model: label, evaluated: 0, ideas: 0, holds: 0, failed: 0, hits: 0, hitRate: null,
      avgReturnPct: null, pnl: 0, fees: 0, wins: 0, winRate: null, maxDrawdown: 0, bestPct: null, worstPct: null,
    };
    const seatIdeas: ReplayIdea[] = [];
    let sumRet = 0;

    for (let k = 0; k < evalIdx.length; k += stride) {
      if (opts.isCancelled?.()) throw new Error('cancelled');
      const i = evalIdx[k]!;
      const now = candles[i]!;
      const back = backIdx[i]! >= 0 ? candles[backIdx[i]!] : undefined;
      // Only candles up to i: this is everything the seat is allowed to know.
      const change24h = back ? round(((now.c - back.c) / back.c) * 100, 2) : null;
      r.evaluated += 1;
      let side: 'BUY' | 'SELL' | 'HOLD';
      let size: number;
      let confidence: number;
      let rationale: string;

      if (seat.usesModel) {
        if (!opts.advisor) {
          r.failed += 1;
          done += 1;
          continue;
        }
        const ctx: MarketContext = { role: seat.role, mandate: seat.mandate, symbol: params.symbol, price: now.c, change24h };
        const res = await opts.advisor.advise(seat.model, ctx, seat.temperature).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'failed' }));
        if (!res.ok) {
          r.failed += 1;
          done += 1;
          opts.onProgress?.(done / totalWork);
          continue;
        }
        ({ side, size, confidence } = sizeIntent(res.view.side, res.view.confidence, seat.maxClip, now.c));
        rationale = res.view.rationale;
      } else {
        ({ side, size, confidence } = momentumIntent(change24h, seat.maxClip, now.c));
        rationale = `stub momentum rule: ${change24h ?? 0}% over 24h`;
      }
      done += 1;
      if (done % 250 === 0) {
        opts.onProgress?.(done / totalWork);
        await new Promise((res) => setImmediate(res)); // keep core responsive during a long replay
      }

      if (side === 'HOLD' || size <= 0) {
        r.holds += 1;
        continue;
      }
      const exit = candles[i + params.horizon]!; // read only now, after the decision
      const dir = side === 'BUY' ? 1 : -1;
      const ret = ((exit.c - now.c) / now.c) * 100 * dir;
      const fees = size * now.c * fee + size * exit.c * fee;
      const pnl = size * (exit.c - now.c) * dir - fees;
      r.ideas += 1;
      if (ret > 0) r.hits += 1;
      if (pnl > 0) r.wins += 1;
      r.pnl += pnl;
      r.fees += fees;
      sumRet += ret;
      r.bestPct = r.bestPct === null ? ret : Math.max(r.bestPct, ret);
      r.worstPct = r.worstPct === null ? ret : Math.min(r.worstPct, ret);
      seatIdeas.push({
        ts: now.t, role: seat.role, name: seat.name, model: label, symbol: params.symbol, side, size, confidence, rationale,
        price: now.c, change24h, exitTs: exit.t, exitPrice: exit.c, returnPct: round(ret, 4), correct: ret > 0, pnl: round(pnl, 4),
      });
    }

    // Drawdown on the equity curve, with each trade's P&L booked when it closes.
    let eq = 0;
    let peak = 0;
    for (const t of seatIdeas.slice().sort((a, b) => a.exitTs - b.exitTs)) {
      eq += t.pnl;
      peak = Math.max(peak, eq);
      r.maxDrawdown = Math.max(r.maxDrawdown, peak - eq);
    }
    if (r.ideas) {
      r.hitRate = r.hits / r.ideas;
      r.winRate = r.wins / r.ideas;
      r.avgReturnPct = round(sumRet / r.ideas, 4);
      r.bestPct = round(r.bestPct!, 4);
      r.worstPct = round(r.worstPct!, 4);
    }
    r.pnl = round(r.pnl, 2);
    r.fees = round(r.fees, 2);
    r.maxDrawdown = round(r.maxDrawdown, 2);
    results.push(r);
    ideas.push(...seatIdeas);
  }
  opts.onProgress?.(1);

  const a = candles[first];
  const b = candles[Math.max(first, last)];
  return {
    from: a?.t ?? startTs,
    to: b?.t ?? startTs,
    candles: Math.max(0, last - first + 1),
    marketReturnPct: a && b ? round(((b.c - a.c) / a.c) * 100, 4) : 0,
    seats: results,
    ideas: ideas.sort((x, y) => x.ts - y.ts),
  };
}

// ---- jobs --------------------------------------------------------------------------------------------------------

export type JobStatus = 'fetching' | 'running' | 'done' | 'failed' | 'cancelled';
export interface ReplayJob {
  id: string;
  status: JobStatus;
  progress: number;
  params: ReplayParams;
  seats: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: ReplayResult | null;
}

export interface ReplayRunnerDeps {
  /** Crypto history straight from the exchanges. Ignored for symbols `history` handles. */
  fetchJson: FetchJson;
  /** Optional: history for a symbol (core uses this for stocks). Return null to fall back to `fetchJson`. */
  history?: (symbol: string, tf: ReplayTf, from: number, to: number, isCancelled: () => boolean) => Promise<{ candles: Candle[]; source: string } | null>;
  /** Extra history to fetch before the window. Default 24h; stocks need more to cover weekends. */
  warmupMs?: (symbol: string) => number;
  now: () => number;
  advisor?: Advisor;
  /** The seats to replay, built from the engine's current settings when the job starts. */
  seatsFor: (roles: string[] | undefined) => ReplaySeat[];
}

/** One replay at a time; the last finished one is kept so the Desk can show it after a reload. */
export function createReplayRunner(deps: ReplayRunnerDeps) {
  let job: ReplayJob | null = null;
  let cancelled = false;
  let seq = 0;

  const view = (j: ReplayJob, withIdeas = false): ReplayJob =>
    withIdeas || !j.result ? { ...j } : { ...j, result: { ...j.result, ideas: [] } };

  return {
    current: (): ReplayJob | null => (job ? view(job) : null),
    get: (id: string): ReplayJob | null => (job && job.id === id ? view(job) : null),
    ideas: (id: string) => (job && job.id === id && job.result ? job.result.ideas : null),
    running: (): boolean => !!job && (job.status === 'fetching' || job.status === 'running'),

    start(params: ReplayParams, roles?: string[]): ReplayJob | { error: string } {
      if (job && (job.status === 'fetching' || job.status === 'running')) return { error: 'a replay is already running' };
      const seats = deps.seatsFor(roles);
      if (!seats.length) return { error: 'no trading seats to replay' };
      cancelled = false;
      const startedAt = deps.now();
      const to = Math.floor(startedAt / REPLAY_TF_MS[params.timeframe]) * REPLAY_TF_MS[params.timeframe];
      const startTs = to - params.days * DAY;
      const j: ReplayJob = {
        id: `R${startedAt.toString(36)}-${(seq++).toString(36)}`, status: 'fetching', progress: 0, params, seats: seats.map((s) => s.role),
        startedAt, finishedAt: null, error: null, result: null,
      };
      job = j;
      void (async () => {
        try {
          // Extra history before the window, so the first candle already has a 24h change.
          const from = startTs - (deps.warmupMs?.(params.symbol) ?? DAY);
          const got = (await deps.history?.(params.symbol, params.timeframe, from, to, () => cancelled)) ?? (await fetchHistory(deps.fetchJson, params.symbol, params.timeframe, from, to, () => cancelled));
          const { candles, source } = got;
          if (candles.length < params.horizon + 2 || !candles.some((c) => c.t >= startTs)) throw new Error('not enough history for this window');
          j.status = 'running';
          const res = await runReplay(params, seats, candles, startTs, {
            advisor: deps.advisor,
            isCancelled: () => cancelled,
            onProgress: (p) => {
              j.progress = Math.min(1, Math.max(j.progress, p));
            },
          });
          j.result = { ...res, source };
          j.status = 'done';
          j.progress = 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          j.status = msg === 'cancelled' ? 'cancelled' : 'failed';
          j.error = msg === 'cancelled' ? null : msg.slice(0, 200);
        } finally {
          j.finishedAt = deps.now();
        }
      })();
      return view(j);
    },

    cancel(id: string): boolean {
      if (!job || job.id !== id || !(job.status === 'fetching' || job.status === 'running')) return false;
      cancelled = true;
      return true;
    },
  };
}

export type ReplayRunner = ReturnType<typeof createReplayRunner>;
