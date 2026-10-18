// Public market-data fetchers (no API keys). Browser-side for now, mirroring the v2 prototype.
// Production moves this polling into Bourse Core and streams to the UI over WebSocket;
// useDesk is the only caller, so that swap is contained to this file + useDesk.

import { LBL, TAPE } from "./data";

const BINANCE = "https://data-api.binance.vision/api/v3";

export interface Quote {
  px: number;
  chg: number;
  vol: number;
}
export type FeedName = "CONNECTING" | "BINANCE" | "COINBASE" | "SIMULATED";

async function getJSON<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}
interface CoinbaseStats {
  last: string;
  open: string;
  volume: string;
}

const finiteOr0 = (n: number): number => (Number.isFinite(n) ? n : 0);

/** 24h tickers for every tape symbol: Binance first, Coinbase as fallback. null = nothing reachable. */
export async function fetchQuotes(): Promise<{ quotes: Record<string, Quote>; feed: FeedName } | null> {
  try {
    const j = await getJSON<BinanceTicker[]>(
      BINANCE + "/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(TAPE.map((t) => t.k))),
    );
    const quotes: Record<string, Quote> = {};
    for (const t of j) {
      const px = +t.lastPrice;
      if (!Number.isFinite(px) || px <= 0) continue; // never let a bad print become a price
      quotes[t.symbol] = { px, chg: finiteOr0(+t.priceChangePercent), vol: finiteOr0(+t.quoteVolume) };
    }
    if (!Object.keys(quotes).length) throw new Error("no usable Binance quotes");
    return { quotes, feed: "BINANCE" };
  } catch {
    try {
      const quotes: Record<string, Quote> = {};
      await Promise.all(
        TAPE.filter((t) => t.cb).map(async (t) => {
          const j = await getJSON<CoinbaseStats>("https://api.exchange.coinbase.com/products/" + t.cb + "/stats");
          const last = +j.last;
          const open = +j.open;
          if (!Number.isFinite(last) || last <= 0) return;
          quotes[t.k] = {
            px: last,
            chg: Number.isFinite(open) && open > 0 ? (last / open - 1) * 100 : 0,
            vol: finiteOr0(+j.volume * last),
          };
        }),
      );
      return Object.keys(quotes).length ? { quotes, feed: "COINBASE" } : null;
    } catch {
      return null;
    }
  }
}

export interface Candle {
  /** Open time, ms epoch. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
export const TF_MS: Record<Timeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** TradingView widget interval for each timeframe. */
export const TF_TV: Record<Timeframe, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
/** Coinbase has no 4h granularity: fetch 1h and merge each 4 into one. */
const CB_GRAN: Record<Timeframe, [number, number]> = { "1m": [60, 1], "5m": [300, 1], "15m": [900, 1], "1h": [3600, 1], "4h": [3600, 4], "1d": [86400, 1] };

const okCandle = (c: Candle) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.o > 0 && c.c > 0 && c.h >= c.l;

/** Merge consecutive candles n at a time, aligned to the bigger bucket's boundary. */
export function mergeCandles(cs: Candle[], n: number, bucketMs: number): Candle[] {
  if (n <= 1) return cs;
  const out: Candle[] = [];
  for (const c of cs) {
    const t = Math.floor(c.t / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    } else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c });
  }
  return out;
}

/** Up to 120 candles, oldest first. Binance, then Coinbase. Null when neither answers. */
export async function fetchCandles(sym: string, tf: Timeframe = "5m"): Promise<Candle[] | null> {
  try {
    const j = await getJSON<Array<Array<string | number>>>(BINANCE + "/klines?symbol=" + sym + "&interval=" + tf + "&limit=120");
    const cs = j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })).filter(okCandle);
    if (!cs.length) throw new Error("no candles");
    return cs;
  } catch {
    try {
      const cb = LBL[sym]?.cb;
      if (!cb) return null;
      const [gran, n] = CB_GRAN[tf];
      // Coinbase rows: [time (s), low, high, open, close, volume], newest first.
      const j = await getJSON<Array<Array<number>>>("https://api.exchange.coinbase.com/products/" + cb + "/candles?granularity=" + gran);
      const cs = j.map((k) => ({ t: +k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4] })).filter(okCandle).reverse();
      const merged = mergeCandles(cs, n, TF_MS[tf]).slice(-120);
      return merged.length ? merged : null;
    } catch {
      return null;
    }
  }
}

/** Closes only, for callers that just want a line. */
export async function fetchCloses(sym: string, tf: Timeframe = "5m"): Promise<number[] | null> {
  const cs = await fetchCandles(sym, tf);
  return cs ? cs.map((c) => c.c) : null;
}

/** Funding expressed as the 8h rate in percent, which is what the UI labels it as. */
export async function fetchFundingRate(sym: string): Promise<number | null> {
  try {
    const j = await getJSON<{ lastFundingRate: string }>("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + sym);
    const r = +j.lastFundingRate * 100;
    if (!Number.isFinite(r)) throw new Error("bad funding");
    return r;
  } catch {
    try {
      const r = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const j = (await r.json()) as [{ universe: Array<{ name: string }> }, Array<{ funding: string }>];
      const coin = sym.replace("USDT", "");
      const ix = j[0].universe.findIndex((u) => u.name === coin);
      // Hyperliquid funding is per hour; scale to the 8h convention Binance (and the UI label) use.
      const hourly = ix > -1 ? +j[1][ix].funding : NaN;
      return Number.isFinite(hourly) ? hourly * 100 * 8 : null;
    } catch {
      return null;
    }
  }
}

export async function fetchEurUsd(): Promise<number | null> {
  try {
    const j = await getJSON<{ rates: { USD: number } }>("https://api.frankfurter.app/latest?from=EUR&to=USD");
    return +j.rates.USD;
  } catch {
    return null;
  }
}
