import { CORE_URL } from "./secrets";
import { LBL, PERP, type Autonomy, type Side } from "./data";
import { cm, fmt, fmtQty } from "./format";
import type { Approval, DeskState, Fill, SeqEvent } from "./state";
import { walk } from "./format";

/**
 * The Desk's side of Hermes Core's /agents stream. Pure functions: the socket lives in useDesk, everything it receives
 * goes through `parseCoreMsg` (untrusted input) and `applyCoreMsg` (state in, patch out).
 */

export type CoreStatus = "connecting" | "live" | "offline";

export type CoreMsg =
  | { type: "lifecycle"; agentId: string; role: string; status: "initialized" | "running" | "paused" | "halted"; ts: number }
  | { type: "intent"; agentId: string; role: string; symbol: string; side: Side | "HOLD"; size: number; confidence: number; rationale: string; ts: number }
  | { type: "config"; agentId: string; role: string; name: string; model: string; temperature: number; autonomy: Autonomy; mandate: string; paused: boolean; riskLimits: { maxClip: number; maxLeverage: number; dailyLossStop: number }; ts: number }
  | { type: "pnl"; agentId: string; role: string; pnl: number; exposure: number; positions: Array<{ symbol: string; qty: number; avgPx: number }>; ts: number }
  | { type: "decision"; agentId: string; role: string; symbol: string; action: Side | "HOLD"; size: number; price: number; rationale: string; riskChecked: boolean; ts: number };

export const coreFloorUrl = (base: string = CORE_URL): string => base.replace(/^http/, "ws").replace(/\/$/, "") + "/agents";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sideOf = (v: unknown): v is Side | "HOLD" => v === "BUY" || v === "SELL" || v === "HOLD";

/** Returns a typed message, or null for anything that isn't exactly what core sends. */
export function parseCoreMsg(raw: unknown): CoreMsg | null {
  if (!isObj(raw) || !str(raw.agentId, 64) || !str(raw.role, 64) || !num(raw.ts)) return null;
  const { agentId, role, ts } = raw;
  if (raw.type === "lifecycle") {
    const st = raw.status;
    return st === "initialized" || st === "running" || st === "paused" || st === "halted" ? { type: "lifecycle", agentId, role, status: st, ts } : null;
  }
  if (raw.type === "config") {
    const rl = raw.riskLimits;
    const a = raw.autonomy;
    if (!str(raw.name, 64) || !str(raw.model, 64) || !num(raw.temperature) || !str(raw.mandate, 2000) || typeof raw.paused !== "boolean") return null;
    if (a !== "SUGGEST" && a !== "APPROVE" && a !== "AUTO") return null;
    if (!isObj(rl) || !num(rl.maxClip) || !num(rl.maxLeverage) || !num(rl.dailyLossStop)) return null;
    return {
      type: "config", agentId, role, name: raw.name, model: raw.model, temperature: raw.temperature, autonomy: a, mandate: raw.mandate,
      paused: raw.paused, riskLimits: { maxClip: rl.maxClip, maxLeverage: rl.maxLeverage, dailyLossStop: rl.dailyLossStop }, ts,
    };
  }
  if (raw.type === "pnl") {
    if (!num(raw.pnl) || !num(raw.exposure) || raw.exposure < 0 || !Array.isArray(raw.positions) || raw.positions.length > 16) return null;
    const positions: Array<{ symbol: string; qty: number; avgPx: number }> = [];
    for (const p of raw.positions) {
      if (!isObj(p) || !str(p.symbol, 32) || !num(p.qty) || !num(p.avgPx)) return null;
      positions.push({ symbol: p.symbol, qty: p.qty, avgPx: p.avgPx });
    }
    return { type: "pnl", agentId, role, pnl: raw.pnl, exposure: raw.exposure, positions, ts };
  }
  if (!str(raw.symbol, 32) || !str(raw.rationale)) return null;
  if (raw.type === "intent") {
    if (!sideOf(raw.side) || !num(raw.size) || raw.size < 0 || !num(raw.confidence)) return null;
    return { type: "intent", agentId, role, symbol: raw.symbol, side: raw.side, size: raw.size, confidence: raw.confidence, rationale: raw.rationale, ts };
  }
  if (raw.type === "decision") {
    if (!sideOf(raw.action) || !num(raw.size) || raw.size < 0 || !num(raw.price) || raw.price <= 0 || typeof raw.riskChecked !== "boolean") return null;
    return { type: "decision", agentId, role, symbol: raw.symbol, action: raw.action, size: raw.size, price: raw.price, rationale: raw.rationale, riskChecked: raw.riskChecked, ts };
  }
  return null;
}

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
/** Core and the Desk share a roster; seats are matched by role. */
export const seatOf = (s: DeskState, role: string): number => s.agents.findIndex((a) => norm(a.role) === norm(role));
/** "BTC-USDT" → the Desk's "BTCUSDT" key, or null for anything the Desk doesn't list. */
export const deskSym = (sym: string): string | null => {
  const k = sym.replace("-", "");
  return Object.prototype.hasOwnProperty.call(LBL, k) ? k : null;
};

const push = (seq: SeqEvent[], e: SeqEvent): SeqEvent[] => seq.concat([e]).slice(-80);

/** First message of a core session: drop the scripted demo content so nothing fake sits next to real events. */
export function onCoreConnected(s: DeskState, now: number): Partial<DeskState> {
  return {
    core: "live",
    seq: [{ sysText: "Connected to Hermes Core. The scripted conversation is off; you are seeing events from core's stub agents.", t: now }],
    fills: [],
    approvals: [],
    coreBook: {},
    series: s.series.map(() => walk(26, 1, 0).map(() => 0)),
  };
}

export function onCoreLost(s: DeskState, now: number, was: CoreStatus): Partial<DeskState> {
  if (was !== "live") return { core: "offline" };
  return { core: "offline", seq: push(s.seq, { sysText: "Lost connection to Hermes Core. Back to the simulated floor.", t: now }) };
}

export function applyCoreMsg(s: DeskState, m: CoreMsg): Partial<DeskState> | null {
  if (m.type === "lifecycle") {
    // Per-seat pause arrives in `config`; lifecycle only tells us about the floor as a whole.
    return m.agentId === "*" ? { halted: m.status === "halted" } : null;
  }

  if (m.type === "config") {
    const i = seatOf(s, m.role);
    if (i < 0) return null;
    const { maxClip, maxLeverage, dailyLossStop } = m.riskLimits;
    return {
      agents: s.agents.map((a, j) =>
        j === i
          ? {
              ...a, model: m.model, temp: m.temperature, autonomy: m.autonomy, mandate: m.mandate, paused: m.paused,
              maxClip: cm(maxClip), leverage: maxLeverage.toFixed(1) + "x", lossStop: "-" + cm(dailyLossStop),
              tokens: "0", spend: "$0.00", latency: "—", // the stub agents never call a model
            }
          : a,
      ),
    };
  }

  if (m.type === "pnl") {
    const j = seatOf(s, m.role);
    if (j < 0) return null;
    const positions = m.positions.flatMap((p) => {
      const key = deskSym(p.symbol);
      return key ? [{ k: key, qty: p.qty }] : [];
    });
    return { coreBook: { ...s.coreBook, [j]: { pnl: m.pnl, exposure: m.exposure, positions } } };
  }

  const i = seatOf(s, m.role);
  const k = deskSym(m.symbol);
  if (i < 0 || !k) return null;
  const ag = s.agents[i]!;
  const first = ag.name.split(" ")[0]!;
  const t = m.ts;

  if (m.type === "intent") {
    // AUTO seats' intents are followed by a decision, which is what the floor shows. Everyone else needs a human.
    if (m.side === "HOLD" || ag.autonomy === "AUTO") return null;
    const a: Approval = { id: `C${t}-${m.agentId}-${k}`, who: i, side: m.side, k, q: m.size, why: m.rationale, t, kind: ag.autonomy, mult: 1, raw: true };
    const rest = s.approvals.filter((x) => !(x.raw && x.who === i && x.k === k));
    return { approvals: rest.concat([a]).slice(-20) };
  }

  // decision
  if (m.action === "HOLD" || m.size === 0) {
    return m.riskChecked ? null : { seq: push(s.seq, { sysText: `${first} · ${PERP(k)} vetoed by the risk gate: ${m.rationale}`, t }) };
  }
  const fill: Fill = { side: m.action, k, q: m.size, agent: ag.name, t, px: m.price, status: "FILLED", raw: true };
  return {
    fills: [fill].concat(s.fills).slice(0, 40),
    seq: push(s.seq, { sysText: `${first} · ${m.action} ${PERP(k)} ${fmtQty(m.size)} @ ${fmt(m.price, LBL[k]!.dp)} · paper · risk checked`, t }),
  };
}
