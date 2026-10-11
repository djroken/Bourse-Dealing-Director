// Pure formatting + geometry helpers for the Desk. Ported 1:1 from the v2 prototype.

export function fmt(n: number | null | undefined, dp: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function money(n: number): string {
  const s = n < 0 ? "-" : "+";
  return s + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
}

/** Compact money: $1.84M, $620.0k, $95 */
export function cm(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (a / 1e3).toFixed(1) + "k";
  return "$" + a.toFixed(0);
}

export function fmtQty(q: number): string {
  const a = Math.abs(q);
  return fmt(q, a < 1 ? 4 : a < 100 ? 2 : 0);
}

export function hms(t: number): string {
  return new Date(t).toISOString().slice(11, 19);
}

/** SVG path for a series scaled into a w×h box. `close` adds a baseline for the area fill. */
export function path(series: number[], w: number, h: number, close: boolean): string {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const last = Math.max(1, series.length - 1);
  const pts = series.map((v, i) => [(i / last) * w, h - ((v - min) / span) * (h - 4) - 2]);
  let d = "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L");
  if (close) d += " L" + w + " " + h + " L0 " + h + " Z";
  return d;
}

/** Deterministic pseudo-random walk, used for sparklines and the offline chart fallback. */
export function walk(n: number, seed: number, drift: number): number[] {
  const out: number[] = [];
  let v = 100;
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v += (s / 2147483648 - 0.5) * 4 + (drift || 0);
    out.push(v);
  }
  return out;
}
