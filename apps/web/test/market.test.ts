import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCloses, fetchEurUsd, fetchFundingRate, fetchQuotes } from "../lib/desk/market";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
const stubFetch = (routes: Array<[string, () => Response | Promise<Response>]>) =>
  vi.stubGlobal("fetch", async (url: string) => {
    for (const [needle, fn] of routes) if (url.includes(needle)) return fn();
    throw new Error("offline: " + url);
  });

describe("fetchQuotes", () => {
  it("reads Binance 24h tickers", async () => {
    stubFetch([["binance.vision", () => json([{ symbol: "BTCUSDT", lastPrice: "100", priceChangePercent: "2.5", quoteVolume: "9000" }])]]);
    expect(await fetchQuotes()).toEqual({ feed: "BINANCE", quotes: { BTCUSDT: { px: 100, chg: 2.5, vol: 9000 } } });
  });

  it("drops a bad print instead of turning it into a price", async () => {
    stubFetch([
      ["binance.vision", () => json([
        { symbol: "BTCUSDT", lastPrice: "100", priceChangePercent: "1", quoteVolume: "1" },
        { symbol: "ETHUSDT", lastPrice: "0", priceChangePercent: "1", quoteVolume: "1" },
        { symbol: "SOLUSDT", lastPrice: "abc", priceChangePercent: "1", quoteVolume: "1" },
      ])],
    ]);
    const got = await fetchQuotes();
    expect(Object.keys(got!.quotes)).toEqual(["BTCUSDT"]);
  });

  it("falls back to Coinbase when Binance is unreachable, and survives a zero open", async () => {
    stubFetch([["exchange.coinbase.com", () => json({ last: "50", open: "0", volume: "10" })]]);
    const got = await fetchQuotes();
    expect(got?.feed).toBe("COINBASE");
    for (const q of Object.values(got!.quotes)) {
      expect(q.px).toBe(50);
      expect(q.chg).toBe(0); // not Infinity
    }
  });

  it("returns null when nothing is reachable", async () => {
    stubFetch([]);
    expect(await fetchQuotes()).toBeNull();
  });
});

describe("fetchCloses", () => {
  it("maps Binance klines to closes", async () => {
    stubFetch([["klines", () => json([[0, "1", "2", "0", "1.5"], [1, "1", "2", "0", "1.7"]])]]);
    expect(await fetchCloses("BTCUSDT")).toEqual([1.5, 1.7]);
  });
  it("is null for an unknown symbol when offline", async () => {
    stubFetch([]);
    expect(await fetchCloses("NOPE")).toBeNull();
  });
});

describe("fetchFundingRate", () => {
  it("returns Binance's 8h rate as a percent", async () => {
    stubFetch([["premiumIndex", () => json({ lastFundingRate: "0.0001" })]]);
    expect(await fetchFundingRate("BTCUSDT")).toBeCloseTo(0.01, 10);
  });
  it("scales Hyperliquid's hourly rate to 8h so the label stays true", async () => {
    stubFetch([["hyperliquid", () => json([{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ funding: "0.0000125" }, { funding: "0.00002" }]])]]);
    expect(await fetchFundingRate("ETHUSDT")).toBeCloseTo(0.00002 * 100 * 8, 10);
  });
  it("is null for an unknown coin or an outage", async () => {
    stubFetch([["hyperliquid", () => json([{ universe: [{ name: "BTC" }] }, [{ funding: "0.1" }]])]]);
    expect(await fetchFundingRate("DOGEUSDT")).toBeNull();
    stubFetch([]);
    expect(await fetchFundingRate("BTCUSDT")).toBeNull();
  });
});

describe("fetchEurUsd", () => {
  it("reads the rate, or null", async () => {
    stubFetch([["frankfurter", () => json({ rates: { USD: 1.08 } })]]);
    expect(await fetchEurUsd()).toBe(1.08);
    stubFetch([]);
    expect(await fetchEurUsd()).toBeNull();
  });
});
