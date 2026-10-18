import { fmt } from "./format";
import type { Candle } from "./market";
import type { Signal } from "./signals";

/**
 * Pure geometry for the native chart: candles in an SVG viewBox, plus price-grid labels and signal markers in percent
 * coordinates so the component can place them as HTML (crisp at any size, and hoverable).
 */

export interface CandleBox { key: number; x: number; w: number; bodyY: number; bodyH: number; wickY1: number; wickY2: number; up: boolean }
export interface GridLine { y: number; yPct: number; label: string }
export interface Marker {
  key: string;
  xPct: number;
  yPct: number;
  side: "BUY" | "SELL";
  /** hit / miss once scored (majority of the ideas in this group), open before. */
  state: "hit" | "miss" | "open";
  count: number;
  /** One line per idea (up to 4) for the tooltip. */
  lines: string[];
  title: string;
}
export interface ChartGeo {
  W: number;
  H: number;
  candles: CandleBox[];
  grid: GridLine[];
  markers: Marker[];
  lastYPct: number;
  lastLabel: string;
  up: boolean;
  /** Ideas on this symbol that fall inside the visible candles. */
  visibleSignals: number;
}

const PAD_TOP = 14;
const PAD_BOT = 14;

/** Fold the live price into the newest candle so the chart moves between candle fetches. */
export function withLive(cs: Candle[], live: number | null | undefined): Candle[] {
  if (!cs.length || !live || !Number.isFinite(live) || live <= 0) return cs;
  const last = cs[cs.length - 1]!;
  return cs.slice(0, -1).concat([{ ...last, c: live, h: Math.max(last.h, live), l: Math.min(last.l, live) }]);
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
};

export function chartGeometry(
  candlesIn: Candle[],
  live: number | null | undefined,
  signals: Signal[],
  tfMs: number,
  dp: number,
  now: number,
  W = 600,
  H = 340,
): ChartGeo {
  const cs = withLive(candlesIn, live);
  const n = cs.length;
  if (!n) return { W, H, candles: [], grid: [], markers: [], lastYPct: 50, lastLabel: "—", up: true, visibleSignals: 0 };

  const t0 = cs[0]!.t;
  const tEnd = cs[n - 1]!.t + tfMs;
  const inView = signals.filter((s) => s.t >= t0 && s.t < tEnd);

  let lo = Math.min(...cs.map((c) => c.l), ...inView.map((s) => s.px));
  let hi = Math.max(...cs.map((c) => c.h), ...inView.map((s) => s.px));
  if (!(hi > lo)) {
    hi = hi * 1.001 + 1e-9;
    lo = lo * 0.999;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const y = (p: number) => PAD_TOP + ((hi - p) / (hi - lo)) * (H - PAD_TOP - PAD_BOT);
  const slot = W / n;
  const bw = Math.max(1, slot * 0.64);

  const candles: CandleBox[] = cs.map((c, i) => {
    const top = y(Math.max(c.o, c.c));
    const bot = y(Math.min(c.o, c.c));
    return { key: c.t, x: i * slot + (slot - bw) / 2, w: bw, bodyY: top, bodyH: Math.max(0.8, bot - top), wickY1: y(c.h), wickY2: y(c.l), up: c.c >= c.o };
  });

  const grid: GridLine[] = [0.2, 0.4, 0.6, 0.8].map((f) => {
    const gy = PAD_TOP + f * (H - PAD_TOP - PAD_BOT);
    const p = hi - ((gy - PAD_TOP) / (H - PAD_TOP - PAD_BOT)) * (hi - lo);
    return { y: gy, yPct: (gy / H) * 100, label: fmt(p, dp) };
  });

  // Group ideas by candle and side: stub agents can have an idea every few seconds, and a marker per idea is noise.
  const groups = new Map<string, Signal[]>();
  for (const s of inView) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((s.t - t0) / tfMs)));
    const key = i + ":" + s.side;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const markers: Marker[] = [...groups.entries()].map(([key, g]) => {
    const i = Number(key.split(":")[0]);
    const side = g[0]!.side;
    const avgPx = g.reduce((x, s) => x + s.px, 0) / g.length;
    const scored = g.filter((s) => s.outcome);
    const hits = scored.filter((s) => s.outcome!.correct).length;
    const state: Marker["state"] = scored.length < g.length ? "open" : hits * 2 >= scored.length ? "hit" : "miss";
    const newest = g.slice().sort((a, b) => b.t - a.t);
    const lines = newest.slice(0, 4).map((s) => {
      const res = s.outcome ? `${s.outcome.correct ? "right" : "wrong"} ${s.outcome.returnPct >= 0 ? "+" : ""}${s.outcome.returnPct.toFixed(2)}%` : "not scored yet";
      return `${s.name} · ${s.side} @ ${fmt(s.px, dp)} · ${Math.round(s.confidence * 100)}% · ${res}${s.filled ? " · traded" : ""} · ${ago(now - s.t)} ago — ${s.why}`;
    });
    if (g.length > 4) lines.push(`+${g.length - 4} more`);
    return {
      key, side, state, count: g.length, lines,
      xPct: (((i + 0.5) * slot) / W) * 100,
      yPct: (y(avgPx) / H) * 100,
      title: `${g.length} ${side} idea${g.length > 1 ? "s" : ""}${scored.length ? ` · ${hits} of ${scored.length} right` : ""}`,
    };
  });

  const last = cs[n - 1]!.c;
  return { W, H, candles, grid, markers, lastYPct: (y(last) / H) * 100, lastLabel: fmt(last, dp), up: last >= cs[0]!.o, visibleSignals: inView.length };
}

/** Deterministic stand-in candles for when no exchange answers, so the chart is never empty. Labelled SIMULATED. */
export function simCandles(seedPx: number, tfMs: number, now: number, n = 120): Candle[] {
  let seed = 9931;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const end = Math.floor(now / tfMs) * tfMs;
  const out: Candle[] = [];
  let p = seedPx;
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    const c = o * (1 + (rnd() - 0.49) * 0.006);
    out.push({ t: end - i * tfMs, o, c, h: Math.max(o, c) * (1 + rnd() * 0.002), l: Math.min(o, c) * (1 - rnd() * 0.002) });
    p = c;
  }
  // Re-base so the last close sits on the seed price.
  const k = seedPx / out[out.length - 1]!.c;
  return out.map((c) => ({ t: c.t, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
}
