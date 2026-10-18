import { CORE_URL } from "./secrets";

/**
 * AI signals on the chart: the ideas Bourse Core's agents had on a symbol, with what the price did next.
 * Fetched from core's GET /ideas. Everything here is untrusted input and is validated field by field.
 */

export interface Signal {
  id: string;
  /** When the idea was made, ms epoch. */
  t: number;
  /** Desk symbol key, e.g. "BTCUSDT". */
  k: string;
  side: "BUY" | "SELL";
  /** Price the idea was made at. */
  px: number;
  agentId: string;
  name: string;
  role: string;
  model: string;
  confidence: number;
  why: string;
  filled: boolean;
  /** Null until core has scored it. */
  outcome: { returnPct: number; correct: boolean; exitPx: number; horizonMs: number } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One idea record from core, or null if it isn't exactly what core sends. */
export function parseIdea(raw: unknown): Signal | null {
  if (!isObj(raw)) return null;
  const { id, ts, symbol, side, price, agentId, name, role, model, confidence, rationale, filled, outcome } = raw;
  if (!str(id, 64) || !num(ts) || !str(symbol, 32) || (side !== "BUY" && side !== "SELL") || !num(price) || price <= 0) return null;
  if (!str(agentId, 64) || !str(name, 64) || !str(role, 64) || !str(model, 96) || !num(confidence) || !str(rationale, 2000) || typeof filled !== "boolean") return null;
  let out: Signal["outcome"] = null;
  if (outcome !== null) {
    if (!isObj(outcome) || !num(outcome.returnPct) || typeof outcome.correct !== "boolean" || !num(outcome.exitPrice) || !num(outcome.horizonMs)) return null;
    out = { returnPct: outcome.returnPct, correct: outcome.correct, exitPx: outcome.exitPrice, horizonMs: outcome.horizonMs };
  }
  return {
    id, t: ts, k: symbol.replace("-", ""), side, px: price, agentId, name, role, model,
    confidence: Math.min(Math.max(confidence, 0), 1), why: rationale.slice(0, 400), filled, outcome: out,
  };
}

export function parseIdeas(raw: unknown, max = 500): Signal[] {
  if (!Array.isArray(raw)) return [];
  const out: Signal[] = [];
  for (const r of raw.slice(-max)) {
    const s = parseIdea(r);
    if (s) out.push(s);
  }
  return out;
}

/** Core's symbol for a desk key: "BTCUSDT" → "BTC-USDT". */
export const coreSym = (k: string): string => k.replace(/USDT$/, "-USDT");

/** The recent ideas core has for one symbol. Empty when core is down or has none. */
export async function fetchSignals(k: string, base: string = CORE_URL): Promise<Signal[]> {
  try {
    const r = await fetch(`${base}/ideas?symbol=${encodeURIComponent(coreSym(k))}&limit=300`);
    if (!r.ok) return [];
    return parseIdeas(await r.json()).filter((s) => s.k === k);
  } catch {
    return [];
  }
}
