import { CORE_URL } from "./secrets";

/**
 * The Desk's side of core's replay API: run the trading seats over past candles and score every idea.
 * Responses are untrusted and checked before use; anything unexpected becomes an error string, never a crash.
 */

/** Seats that trade (a web test keeps this in step with core's roster). */
export const TRADING_ROLES = ["Execution Trader", "Market Maker", "Quant / Signals", "Sentiment Desk"] as const;
export const REPLAY_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"] as const;
export const REPLAY_TFS = ["1m", "5m", "15m", "1h"] as const;
export const REPLAY_DAYS = [1, 3, 7, 14, 30] as const;
export type ReplayTf = (typeof REPLAY_TFS)[number];
const TF_MIN: Record<ReplayTf, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };

export interface ReplayForm {
  symbol: (typeof REPLAY_SYMBOLS)[number];
  timeframe: ReplayTf;
  days: number;
  horizon: number;
  feeBps: number;
  maxModelCalls: number;
  roles: string[];
}
export const DEFAULT_FORM: ReplayForm = { symbol: "BTC-USDT", timeframe: "5m", days: 7, horizon: 3, feeBps: 5, maxModelCalls: 60, roles: [...TRADING_ROLES] };

/** "3 candles = 15m" style label for the horizon picker. */
export const horizonLabel = (tf: ReplayTf, n: number): string => {
  const min = TF_MIN[tf] * n;
  return min < 60 ? `${min}m` : min % 60 === 0 ? `${min / 60}h` : `${(min / 60).toFixed(1)}h`;
};
/** Candles in the window, so the form can warn before a long 1m replay. */
export const candlesFor = (tf: ReplayTf, days: number): number => Math.round((days * 1440) / TF_MIN[tf]);

export interface SeatResult {
  role: string; name: string; model: string; evaluated: number; ideas: number; holds: number; failed: number; hits: number;
  hitRate: number | null; avgReturnPct: number | null; pnl: number; fees: number; wins: number; winRate: number | null;
  maxDrawdown: number; bestPct: number | null; worstPct: number | null;
}
export interface ReplayJob {
  id: string;
  status: "fetching" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  params: { symbol: string; timeframe: string; days: number; horizon: number; feeBps: number; maxModelCalls: number };
  seats: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: { from: number; to: number; candles: number; source: string; marketReturnPct: number; seats: SeatResult[] } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max;
const STATUSES = new Set(["fetching", "running", "done", "failed", "cancelled"]);

function parseSeat(v: unknown): SeatResult | null {
  if (!isObj(v) || !str(v.role, 64) || !str(v.name, 64) || !str(v.model, 96)) return null;
  for (const k of ["evaluated", "ideas", "holds", "failed", "hits", "pnl", "fees", "wins", "maxDrawdown"]) if (!num(v[k])) return null;
  for (const k of ["hitRate", "avgReturnPct", "winRate", "bestPct", "worstPct"]) if (!numOrNull(v[k])) return null;
  return v as unknown as SeatResult;
}

export function parseJob(v: unknown): ReplayJob | null {
  if (!isObj(v) || !str(v.id, 64) || !str(v.status) || !STATUSES.has(v.status) || !num(v.progress) || !num(v.startedAt)) return null;
  if (!numOrNull(v.finishedAt) || !(v.error === null || str(v.error)) || !Array.isArray(v.seats) || !isObj(v.params)) return null;
  const p = v.params;
  if (!str(p.symbol, 32) || !str(p.timeframe, 8) || !num(p.days) || !num(p.horizon) || !num(p.feeBps) || !num(p.maxModelCalls)) return null;
  let result: ReplayJob["result"] = null;
  if (v.result !== null) {
    const r = v.result;
    if (!isObj(r) || !num(r.from) || !num(r.to) || !num(r.candles) || !str(r.source, 16) || !num(r.marketReturnPct) || !Array.isArray(r.seats)) return null;
    const seats = r.seats.map(parseSeat);
    if (seats.some((s) => s === null)) return null;
    result = { from: r.from, to: r.to, candles: r.candles, source: r.source, marketReturnPct: r.marketReturnPct, seats: seats as SeatResult[] };
  }
  return {
    id: v.id, status: v.status as ReplayJob["status"], progress: Math.min(1, Math.max(0, v.progress)),
    params: { symbol: p.symbol, timeframe: p.timeframe, days: p.days, horizon: p.horizon, feeBps: p.feeBps, maxModelCalls: p.maxModelCalls },
    seats: v.seats.filter((x): x is string => str(x, 64)), startedAt: v.startedAt, finishedAt: v.finishedAt, error: v.error, result,
  };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function startReplay(form: ReplayForm, base: string = CORE_URL): Promise<Result<ReplayJob>> {
  try {
    const r = await fetch(`${base}/replay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const body: unknown = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: isObj(body) && str(body.error, 500) ? body.error : `core answered ${r.status}` };
    const job = parseJob(body);
    return job ? { ok: true, value: job } : { ok: false, error: "core sent an unexpected reply" };
  } catch {
    return { ok: false, error: "Bourse Core isn't reachable. Start it with pnpm dev." };
  }
}

/** The job with this id, or the latest job when no id is given. Null when there is none or core is down. */
export async function getReplay(id?: string, base: string = CORE_URL): Promise<ReplayJob | null> {
  try {
    const r = await fetch(id ? `${base}/replay/${encodeURIComponent(id)}` : `${base}/replay`);
    if (!r.ok) return null;
    const body: unknown = await r.json();
    return parseJob(id ? body : isObj(body) ? body.job : null);
  } catch {
    return null;
  }
}

export async function cancelReplay(id: string, base: string = CORE_URL): Promise<boolean> {
  try {
    return (await fetch(`${base}/replay/${encodeURIComponent(id)}`, { method: "DELETE" })).ok;
  } catch {
    return false;
  }
}

export const replayExportUrl = (id: string, base: string = CORE_URL): string => `${base}/replay/${encodeURIComponent(id)}/ideas.jsonl`;

// ---- display (components never format numbers themselves) ------------------------------------------------------

const UP = "var(--c3ECF8E)";
const DOWN = "var(--cFF7A7A)";
const MUTED = "var(--c7C8894)";
const pct = (r: number | null) => (r === null ? "—" : Math.round(r * 100) + "%");
const signed = (v: number | null, dp = 2) => (v === null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(dp) + "%");
const usd = (n: number) => (n < 0 ? "-" : "+") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export interface ReplayRow {
  key: string; name: string; role: string; model: string; ideas: string; hit: string; hitColor: string; avg: string; avgColor: string;
  win: string; pnl: string; pnlColor: string; dd: string; failed: string; failedColor: string;
}
export interface ReplayView {
  busy: boolean;
  statusLine: string;
  progressPct: number;
  summary: string;
  rows: ReplayRow[];
  exportUrl: string | null;
  error: string | null;
}

export function replayView(job: ReplayJob | null, base: string = CORE_URL): ReplayView | null {
  if (!job) return null;
  const busy = job.status === "fetching" || job.status === "running";
  const p = job.params;
  const statusLine =
    job.status === "fetching" ? `Fetching ${p.days} day${p.days > 1 ? "s" : ""} of ${p.symbol} ${p.timeframe} candles…`
    : job.status === "running" ? `Replaying ${job.seats.length} seat${job.seats.length > 1 ? "s" : ""}… ${Math.round(job.progress * 100)}%`
    : job.status === "done" ? "Replay finished"
    : job.status === "cancelled" ? "Replay cancelled"
    : "Replay failed";
  const r = job.result;
  const summary = r
    ? `${p.symbol} ${p.timeframe} · ${day(r.from)} → ${day(r.to)} UTC · ${r.candles.toLocaleString("en-US")} candles from ${r.source} · ` +
      `outcome ${p.horizon} candle${p.horizon > 1 ? "s" : ""} later · fees ${p.feeBps} bps a side · holding ${p.symbol.split("-")[0]} returned ${signed(r.marketReturnPct)}`
    : "";
  const rows: ReplayRow[] = (r?.seats ?? []).map((s) => ({
    key: s.role, name: s.name, role: s.role.toUpperCase(), model: s.model,
    ideas: `${s.ideas.toLocaleString("en-US")}/${s.evaluated.toLocaleString("en-US")}`,
    hit: s.ideas ? pct(s.hitRate) : "—", hitColor: s.hitRate === null ? MUTED : s.hitRate >= 0.5 ? UP : DOWN,
    avg: signed(s.avgReturnPct, 3), avgColor: s.avgReturnPct === null ? MUTED : s.avgReturnPct >= 0 ? UP : DOWN,
    win: s.ideas ? pct(s.winRate) : "—",
    pnl: s.ideas ? usd(s.pnl) : "—", pnlColor: !s.ideas ? MUTED : s.pnl >= 0 ? UP : DOWN,
    dd: s.maxDrawdown > 0 ? "-$" + Math.round(s.maxDrawdown).toLocaleString("en-US") : "—",
    failed: String(s.failed), failedColor: s.failed ? DOWN : MUTED,
  }));
  return {
    busy, statusLine, progressPct: Math.round((job.status === "done" ? 1 : job.progress) * 100), summary, rows,
    exportUrl: job.status === "done" ? replayExportUrl(job.id, base) : null,
    error: job.status === "failed" ? job.error ?? "unknown error" : null,
  };
}
