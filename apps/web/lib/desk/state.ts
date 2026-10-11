import {
  type Agent, type Autonomy, type Mode, type Setup, type Side,
  DEFAULT_SETUP, FILL_TPL, POS, SCRIPT, SEED_AGENTS, TAPE, VENUES,
} from "./data";
import { walk } from "./format";
import type { FeedName, Quote } from "./market";
import { DEFAULT_GLASS_ALPHA, type ThemeName } from "./theme";

export type Tab = "chat" | "approvals" | "blotter" | "console";
export type MobileTab = "floor" | "chat" | "approvals" | "markets" | "more";
export type Filter = "ALL" | "dir" | "exec" | "res" | "risk";

/** One line in the floor chat. `i` indexes SCRIPT; the others are operator-side events. */
export interface SeqEvent {
  t: number;
  i?: number;
  px?: number | null;
  queued?: boolean;
  user?: string;
  reply?: string;
  sysText?: string;
}
export interface Fill {
  side: Side;
  k: string;
  q: number;
  agent: string;
  t: number;
  px: number;
  status: "FILLED" | "SETTLED";
}
export interface Approval {
  id: string;
  who: number;
  side: Side;
  k: string;
  q: number;
  why: string;
  t: number;
  kind: Autonomy;
  mult: number;
}

export interface DeskState {
  agents: Agent[];
  series: number[][];
  centerOpen: boolean;
  tab: Tab;
  mTab: MobileTab;
  sel: number | null;
  filter: Filter;
  draft: string;
  halted: boolean;
  setup: Setup;
  mode: Mode;
  confirmLive: boolean;
  setupNotice: boolean;
  /** Current onboarding step (0-5) while the setup overlay is open. */
  onbStep: number;
  chartSrc: "tv" | "native";
  chartSym: string;
  live: Record<string, Quote>;
  ref: Record<string, number>;
  kl: Record<string, number[]>;
  feed: FeedName;
  funding: number | null;
  fx: number | null;
  gotLive: boolean;
  seq: SeqEvent[];
  fills: Fill[];
  approvals: Approval[];
  now: number;
  theme: ThemeName;
  glassAlpha: number;
  sysDark: boolean;
  vw: number;
}

export function makeFills(live: Record<string, Quote>, now: number): Fill[] {
  return FILL_TPL.map((x) => ({
    side: x.side, k: x.k, q: x.q, agent: x.agent, t: now - x.ago * 1000,
    px: live[x.k].px * (1 + x.off), status: x.ago > 2000 ? "SETTLED" : "FILLED",
  }));
}

/** Stamp the current price onto order-type script events. */
export function seqPx(seq: SeqEvent[], live: Record<string, Quote>): SeqEvent[] {
  return seq.map((e) => {
    if (e.i === undefined) return e;
    const ev = SCRIPT[e.i];
    return ev.kind === "trade" || ev.kind === "intent" ? { ...e, px: live[ev.k].px } : e;
  });
}

export function createInitialState(now: number): DeskState {
  const live: Record<string, Quote> = {};
  const ref: Record<string, number> = {};
  for (const t of TAPE) {
    live[t.k] = { px: t.seed, chg: 0, vol: 0 };
    ref[t.k] = t.seed;
  }
  const seq = seqPx([0, 1, 2, 3, 4].map((i, j) => ({ i, t: now - (5 - j) * 47000 })), live);
  return {
    agents: SEED_AGENTS.map((a) => ({ ...a, tools: a.tools.slice(), paused: false })),
    series: SEED_AGENTS.map((a, i) =>
      walk(26, 7 + i * 31, a.pnl >= 0 ? 0.22 : -0.28).map((v) => a.pnl + (POS[i] ? (v - 100) * 140 : 0)),
    ),
    centerOpen: true, tab: "chat", mTab: "floor", sel: null, filter: "ALL", draft: "", halted: false,
    setup: { ...DEFAULT_SETUP, on: { ...DEFAULT_SETUP.on }, vals: {}, agentsOn: DEFAULT_SETUP.agentsOn.slice() },
    mode: "demo", confirmLive: false, setupNotice: false, onbStep: 0,
    chartSrc: "tv", chartSym: "BTCUSDT",
    live, ref, kl: {}, feed: "CONNECTING", funding: null, fx: null, gotLive: false,
    seq, fills: makeFills(live, now),
    approvals: [
      { id: "A1", who: 3, side: "BUY", k: "SOLUSDT", q: 900, why: "SOL ranks top decile on momentum and carry is positive. Confidence 0.68.", t: now - 95000, kind: "SUGGEST", mult: 1 },
      { id: "A2", who: 7, side: "SELL", k: "BTCUSDT", q: 3, why: "Crowd long at the 88th percentile with funding skewed long. Small fade into strength.", t: now - 240000, kind: "SUGGEST", mult: 1 },
    ],
    now, theme: "dark", glassAlpha: DEFAULT_GLASS_ALPHA, sysDark: true, vw: 1280,
  };
}

/** Parsed paper capital. The prototype scales its $12.5M reference book to this. */
export function capitalOf(setup: Setup): number {
  return parseFloat(String(setup.capital).replace(/[^0-9.]/g, "")) || 100000;
}
export const bookScale = (setup: Setup): number => capitalOf(setup) / 12.5e6;

export function venuesReady(setup: Setup): Array<{ id: string; name: string }> {
  return VENUES.filter((v) => {
    if (!setup.on["venue." + v.id]) return false;
    return String(setup.vals["venue." + v.id + "." + v.field] || "").trim().length > 0;
  });
}

/** Mark-to-market P&L of agent i in raw (reference-book) dollars. */
export function rawPnl(i: number, live: Record<string, Quote>, ref: Record<string, number>): number {
  const p = POS[i];
  return SEED_AGENTS[i].pnl + (p ? p.q * (live[p.k].px - ref[p.k]) : 0);
}

/** One simulation step: drift prices (if offline), roll sparklines, and maybe play the next script line. */
export function tickState(s: DeskState, autoplay: boolean): Partial<DeskState> {
  const now = Date.now();
  const out: Partial<DeskState> = { now };
  let live = s.live;
  if (!s.gotLive) {
    live = {};
    for (const t of TAPE) {
      const px = s.live[t.k].px * (1 + (Math.random() - 0.49) * 0.0012);
      live[t.k] = { px, chg: (px / t.seed - 1) * 100, vol: 0 };
    }
    out.live = live;
  }
  out.series = s.series.map((ser, i) => (s.agents[i].paused ? ser : ser.slice(1).concat([rawPnl(i, live, s.ref)])));

  if (!s.halted && autoplay && Math.random() < 0.5) {
    let last: SeqEvent | null = null;
    for (let j = s.seq.length - 1; j >= 0; j--) {
      if (s.seq[j].i !== undefined) { last = s.seq[j]; break; }
    }
    const ni = last && last.i !== undefined ? (last.i + 1) % SCRIPT.length : 0;
    const ev = SCRIPT[ni];
    const isOrder = ev.kind === "trade" || ev.kind === "intent";
    const ag = s.agents[ev.who];
    const auto = isOrder && ag.autonomy === "AUTO" && !ag.paused;
    const e: SeqEvent = { i: ni, t: now, px: isOrder ? live[ev.k].px : null, queued: isOrder && !auto };
    out.seq = s.seq.concat([e]).slice(-80);
    if (isOrder && auto) {
      const fill: Fill = { side: ev.side, k: ev.k, q: ev.q, agent: ag.name, t: now, px: e.px as number, status: "FILLED" };
      out.fills = [fill].concat(s.fills).slice(0, 40);
    } else if (isOrder) {
      out.approvals = s.approvals
        .concat([{
          id: "A" + e.t, who: ev.who, side: ev.side, k: ev.k, q: ev.q,
          why: ev.kind === "intent" ? ev.why : "Execute the floor's agreed order.",
          t: e.t, kind: ag.autonomy, mult: 1,
        }])
        .slice(-20);
    }
  }
  return out;
}
