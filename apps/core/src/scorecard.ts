/**
 * Scorecards: each seat's paper track record, and a log of every idea it had with what the market did next.
 *
 * Two different questions, answered separately on purpose:
 *  - "Was the idea any good?" Every BUY/SELL idea is scored against the price `horizonMs` later, whether or not anyone
 *    acted on it. This is the signal you want for evaluating or fine-tuning an agent, because it doesn't depend on
 *    whether the operator happened to approve the trade.
 *  - "Did trading it make money?" Fills, closed trades, wins, P&L and drawdown, from the seat's paper book.
 *
 * Pure bookkeeping: no I/O, no timers. The engine feeds it events; the server decides what to persist.
 */

export interface IdeaInput {
  agentId: string;
  role: string;
  name: string;
  model: string;
  temperature: number;
  autonomy: 'SUGGEST' | 'APPROVE' | 'AUTO';
  symbol: string;
  side: 'BUY' | 'SELL';
  size: number;
  confidence: number;
  rationale: string;
  price: number;
  change24h: number | null;
  source: string;
}

export interface IdeaOutcome {
  horizonMs: number;
  exitPrice: number;
  /** Move in the idea's direction, in percent. Positive = the idea was right. */
  returnPct: number;
  correct: boolean;
}

export interface IdeaRecord extends IdeaInput {
  id: string;
  ts: number;
  /** True once a fill on the paper book was matched to this idea (auto-filled, or approved by the operator). */
  filled: boolean;
  outcome: IdeaOutcome | null;
}

export interface Scorecard {
  agentId: string;
  role: string;
  name: string;
  model: string;
  /** BUY/SELL ideas proposed (HOLDs are counted separately). */
  ideas: number;
  holds: number;
  /** Ideas old enough to be scored, and how many of those went the right way. */
  scored: number;
  hits: number;
  hitRate: number | null;
  /** Mean of the scored ideas' returnPct. */
  avgReturnPct: number | null;
  fills: number;
  vetoes: number;
  /** USD traded (sum of size x price over fills). */
  notional: number;
  /** Fills that reduced or closed a position, and how many of those realised a profit. */
  closes: number;
  wins: number;
  winRate: number | null;
  realized: number;
  pnl: number;
  peakPnl: number;
  /** Largest fall from a P&L peak, in USD (>= 0). */
  maxDrawdown: number;
  updatedAt: number;
}

export interface ScorebookOptions {
  now?: () => number;
  /** How long after an idea its outcome is measured. */
  horizonMs?: number;
  /** Ideas kept in memory for export. Oldest drop off first. */
  maxIdeas?: number;
  /** Called once per idea when its outcome is known: the hook for persisting a training log. */
  onResolved?: (rec: IdeaRecord) => void;
}

/** A fill is matched to the newest unfilled idea from the same seat, symbol and side within this window. */
const MATCH_WINDOW_MS = 30 * 60_000;

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export function createScorebook(opts: ScorebookOptions = {}) {
  const now = opts.now ?? Date.now;
  const horizonMs = opts.horizonMs ?? 15 * 60_000;
  const maxIdeas = opts.maxIdeas ?? 5000;
  const ideas: IdeaRecord[] = [];
  const cards = new Map<string, Scorecard>();
  let seq = 0;

  const card = (a: { agentId: string; role: string; name: string; model: string }): Scorecard => {
    let c = cards.get(a.agentId);
    if (!c) {
      c = {
        agentId: a.agentId, role: a.role, name: a.name, model: a.model,
        ideas: 0, holds: 0, scored: 0, hits: 0, hitRate: null, avgReturnPct: null,
        fills: 0, vetoes: 0, notional: 0, closes: 0, wins: 0, winRate: null,
        realized: 0, pnl: 0, peakPnl: 0, maxDrawdown: 0, updatedAt: now(),
      };
      cards.set(a.agentId, c);
    }
    // Model and name can change at runtime; the card shows the current ones, each idea keeps the one it was made with.
    c.role = a.role;
    c.name = a.name;
    c.model = a.model;
    return c;
  };
  /** Bumped on every change, so callers can tell "changed" apart from "changed within the same millisecond". */
  const revs = new Map<string, number>();
  const touch = (c: Scorecard) => {
    c.updatedAt = now();
    revs.set(c.agentId, (revs.get(c.agentId) ?? 0) + 1);
  };
  const returnSum = new Map<string, number>();

  return {
    horizonMs,

    /** Make sure a seat has a card even before it does anything, so the desk can list every seat. */
    ensure(a: { agentId: string; role: string; name: string; model: string }): void {
      card(a);
    },

    hold(a: { agentId: string; role: string; name: string; model: string }): void {
      const c = card(a);
      c.holds += 1;
      touch(c);
    },

    /** Record a BUY/SELL idea at the price it was made at. Returns its id. */
    idea(input: IdeaInput): string {
      const c = card(input);
      c.ideas += 1;
      touch(c);
      const rec: IdeaRecord = { ...input, id: `I${now().toString(36)}-${(seq++).toString(36)}`, ts: now(), filled: false, outcome: null };
      ideas.push(rec);
      if (ideas.length > maxIdeas) ideas.shift();
      return rec.id;
    },

    /** A fill on the seat's paper book. `realizedDelta` is the change in realised P&L the fill caused. */
    fill(a: { agentId: string; role: string; name: string; model: string }, symbol: string, side: 'BUY' | 'SELL', size: number, price: number, realizedDelta: number): void {
      const c = card(a);
      c.fills += 1;
      c.notional += size * price;
      if (realizedDelta !== 0) {
        c.closes += 1;
        if (realizedDelta > 0) c.wins += 1;
        c.realized += realizedDelta;
        c.winRate = c.wins / c.closes;
      }
      touch(c);
      const t = now();
      for (let i = ideas.length - 1; i >= 0; i--) {
        const r = ideas[i]!;
        if (t - r.ts > MATCH_WINDOW_MS) break;
        if (!r.filled && r.agentId === a.agentId && r.symbol === symbol && r.side === side) {
          r.filled = true;
          break;
        }
      }
    },

    veto(a: { agentId: string; role: string; name: string; model: string }): void {
      const c = card(a);
      c.vetoes += 1;
      touch(c);
    },

    /** Latest marked P&L for a seat: tracks the peak and the worst drawdown from it. */
    mark(a: { agentId: string; role: string; name: string; model: string }, pnl: number): void {
      if (!Number.isFinite(pnl)) return;
      const c = card(a);
      if (c.pnl === pnl) return; // unchanged: don't mark the card as updated
      c.pnl = pnl;
      if (pnl > c.peakPnl) c.peakPnl = pnl;
      const dd = c.peakPnl - pnl;
      if (dd > c.maxDrawdown) c.maxDrawdown = dd;
      touch(c);
    },

    /** A price tick: score every idea on this symbol that has reached its horizon. Returns the ideas resolved. */
    tick(symbol: string, price: number): IdeaRecord[] {
      if (!(price > 0) || !Number.isFinite(price)) return [];
      const t = now();
      const done: IdeaRecord[] = [];
      for (const r of ideas) {
        if (r.outcome || r.symbol !== symbol || t - r.ts < horizonMs) continue;
        const move = ((price - r.price) / r.price) * 100 * (r.side === 'BUY' ? 1 : -1);
        r.outcome = { horizonMs, exitPrice: price, returnPct: round(move, 4), correct: move > 0 };
        const c = cards.get(r.agentId);
        if (c) {
          c.scored += 1;
          if (r.outcome.correct) c.hits += 1;
          const sum = (returnSum.get(r.agentId) ?? 0) + r.outcome.returnPct;
          returnSum.set(r.agentId, sum);
          c.hitRate = c.hits / c.scored;
          c.avgReturnPct = round(sum / c.scored, 4);
          touch(c);
        }
        done.push(r);
        opts.onResolved?.(r);
      }
      return done;
    },

    rev: (agentId: string): number => revs.get(agentId) ?? 0,
    cards: (): Scorecard[] => [...cards.values()].map((c) => ({ ...c })),
    cardOf: (agentId: string): Scorecard | undefined => {
      const c = cards.get(agentId);
      return c ? { ...c } : undefined;
    },
    ideas: (): IdeaRecord[] => ideas.map((r) => ({ ...r, outcome: r.outcome ? { ...r.outcome } : null })),
  };
}

export type Scorebook = ReturnType<typeof createScorebook>;
