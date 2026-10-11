// Public market-data fetchers (no API keys). Browser-side for now, mirroring the v2 prototype.
// Production moves this polling into Hermes Core and streams to the UI over WebSocket;
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

/** 24h tickers for every tape symbol: Binance first, Coinbase as fallback. null = nothing reachable. */
export async function fetchQuotes(): Promise<{ quotes: Record<string, Quote>; feed: FeedName } | null> {
  try {
    const j = await getJSON<BinanceTicker[]>(
      BINANCE + "/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(TAPE.map((t) => t.k))),
    );
    const quotes: Record<string, Quote> = {};
    for (const t of j) quotes[t.symbol] = { px: +t.lastPrice, chg: +t.priceChangePercent, vol: +t.quoteVolume };
    return { quotes, feed: "BINANCE" };
  } catch {
    try {
      const quotes: Record<string, Quote> = {};
      await Promise.all(
        TAPE.filter((t) => t.cb).map(async (t) => {
          const j = await getJSON<CoinbaseStats>("https://api.exchange.coinbase.com/products/" + t.cb + "/stats");
          const last = +j.last;
          const open = +j.open;
          quotes[t.k] = { px: last, chg: (last / open - 1) * 100, vol: +j.volume * last };
        }),
      );
      return Object.keys(quotes).length ? { quotes, feed: "COINBASE" } : null;
    } catch {
      return null;
    }
  }
}

/** 5-minute closes, newest last. */
export async function fetchCloses(sym: string): Promise<number[] | null> {
  try {
    const j = await getJSON<Array<Array<string | number>>>(BINANCE + "/klines?symbol=" + sym + "&interval=5m&limit=120");
    return j.map((c) => +c[4]);
  } catch {
    try {
      const cb = LBL[sym]?.cb;
      if (!cb) return null;
      const j = await getJSON<Array<Array<number>>>(
        "https://api.exchange.coinbase.com/products/" + cb + "/candles?granularity=300",
      );
      return j.slice(0, 120).reverse().map((c) => +c[4]);
    } catch {
      return null;
    }
  }
}

/** Latest 8h funding rate in percent. */
export async function fetchFundingRate(sym: string): Promise<number | null> {
  try {
    const j = await getJSON<{ lastFundingRate: string }>("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + sym);
    return +j.lastFundingRate * 100;
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
      return ix > -1 ? +j[1][ix].funding * 100 : null;
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
