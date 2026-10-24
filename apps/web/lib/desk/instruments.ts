import { CORE_URL } from "./secrets";
import type { TapeItem } from "./data";

/**
 * Core's instrument list (GET /instruments) and its price feed (ws://…/). The built-in crypto keeps its browser feed;
 * anything extra (US stocks, coins added with BOURSE_CRYPTO) is priced by core. Untrusted input, checked field by field.
 */

export interface StocksStatus {
  enabled: boolean;
  keySet: boolean;
  needsRestart: boolean;
  market: { open: boolean; nextOpen: string | null; nextClose: string | null; from: string } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 64): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const SYM = /^[A-Z0-9.]{1,12}(-USDT)?$/;

/** Core's symbol → the Desk's key: "DOGE-USDT" → "DOGEUSDT", "AAPL" → "AAPL". */
export const deskKey = (symbol: string): string => symbol.replace("-", "");

export function parseInstruments(raw: unknown): { items: TapeItem[]; stocks: StocksStatus | null } {
  if (!isObj(raw) || !Array.isArray(raw.instruments)) return { items: [], stocks: null };
  const items: TapeItem[] = [];
  for (const i of raw.instruments.slice(0, 40)) {
    if (!isObj(i) || !str(i.symbol, 16) || !SYM.test(i.symbol) || !str(i.label, 24) || !str(i.tv, 40)) continue;
    if (i.kind !== "crypto" && i.kind !== "stock") continue;
    const dp = typeof i.dp === "number" && Number.isInteger(i.dp) ? Math.min(Math.max(i.dp, 0), 8) : 2;
    items.push({
      k: deskKey(i.symbol), label: i.label, dp, tv: i.tv, cb: str(i.coinbase, 16) ? i.coinbase : null, seed: Number.NaN, kind: i.kind, core: true,
    });
  }
  let stocks: StocksStatus | null = null;
  const st = raw.stocks;
  if (isObj(st) && typeof st.enabled === "boolean") {
    const mk = st.market;
    stocks = {
      enabled: st.enabled, keySet: st.keySet === true, needsRestart: st.needsRestart === true,
      market: isObj(mk) && typeof mk.open === "boolean"
        ? { open: mk.open, nextOpen: str(mk.nextOpen, 40) ? mk.nextOpen : null, nextClose: str(mk.nextClose, 40) ? mk.nextClose : null, from: str(mk.from, 16) ? mk.from : "schedule" }
        : null,
    };
  }
  return { items, stocks };
}

export async function fetchInstruments(base: string = CORE_URL): Promise<{ items: TapeItem[]; stocks: StocksStatus | null } | null> {
  try {
    const r = await fetch(base + "/instruments");
    return r.ok ? parseInstruments(await r.json()) : null;
  } catch {
    return null;
  }
}

/** One price from core's feed socket, or null for anything else (funding, FX, garbage). */
export function parseCorePrice(raw: unknown): { k: string; px: number; chg: number | null; marketOpen?: boolean } | null {
  if (!isObj(raw) || raw.type !== "price" || !str(raw.symbol, 16) || !SYM.test(raw.symbol)) return null;
  if (typeof raw.price !== "number" || !Number.isFinite(raw.price) || raw.price <= 0) return null;
  const chg = typeof raw.change24h === "number" && Number.isFinite(raw.change24h) ? raw.change24h : null;
  return { k: deskKey(raw.symbol), px: raw.price, chg, ...(typeof raw.marketOpen === "boolean" ? { marketOpen: raw.marketOpen } : {}) };
}

export const coreFeedUrl = (base: string = CORE_URL): string => base.replace(/^http/, "ws").replace(/\/$/, "") + "/";

/** Candles for a stock from core (crypto candles come from the exchanges). */
export async function fetchCoreCandles(k: string, tf: string, base: string = CORE_URL): Promise<Array<{ t: number; o: number; h: number; l: number; c: number }> | null> {
  try {
    const r = await fetch(`${base}/candles?symbol=${encodeURIComponent(k)}&tf=${encodeURIComponent(tf)}`);
    if (!r.ok) return null;
    const j: unknown = await r.json();
    if (!isObj(j) || !Array.isArray(j.candles)) return null;
    const out = j.candles.filter(
      (c): c is { t: number; o: number; h: number; l: number; c: number } =>
        isObj(c) && [c.t, c.o, c.h, c.l, c.c].every((x) => typeof x === "number" && Number.isFinite(x)) && (c.c as number) > 0 && (c.h as number) >= (c.l as number),
    );
    return out.length ? out.slice(-120) : null;
  } catch {
    return null;
  }
}
