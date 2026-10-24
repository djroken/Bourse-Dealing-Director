import { afterEach, describe, expect, it, vi } from "vitest";
import { addInstruments, allTape, LBL, resetInstruments, TAPE } from "../lib/desk/data";
import { coreFeedUrl, deskKey, fetchCoreCandles, parseCorePrice, parseInstruments } from "../lib/desk/instruments";
import { createInitialState, tickState, type DeskState } from "../lib/desk/state";
import { buildView } from "../lib/desk/view";
import { deskSym } from "../lib/desk/core";

afterEach(() => {
  resetInstruments();
  vi.unstubAllGlobals();
});

const body = {
  instruments: [
    { symbol: "BTC-USDT", kind: "crypto", label: "BTC/USDT", dp: 0, tv: "BINANCE:BTCUSDT", binance: "BTCUSDT", coinbase: "BTC-USD", coin: "BTC" },
    { symbol: "DOGE-USDT", kind: "crypto", label: "DOGE/USDT", dp: 4, tv: "BINANCE:DOGEUSDT", binance: "DOGEUSDT", coinbase: "DOGE-USD", coin: "DOGE" },
    { symbol: "AAPL", kind: "stock", label: "AAPL", dp: 2, tv: "AAPL" },
    { symbol: "<script>", kind: "stock", label: "x", dp: 2, tv: "x" },
    { symbol: "MSFT", kind: "bond", label: "MSFT", dp: 2, tv: "MSFT" },
  ],
  stocks: { enabled: true, keySet: true, needsRestart: false, market: { open: false, nextOpen: "2026-10-26T09:30:00-04:00", nextClose: null, from: "alpaca" } },
};

describe("core's instruments", () => {
  it("parses the list, drops anything malformed, and reads the market clock", () => {
    const { items, stocks } = parseInstruments(body);
    expect(items.map((i) => i.k)).toEqual(["BTCUSDT", "DOGEUSDT", "AAPL"]);
    expect(items.find((i) => i.k === "AAPL")).toMatchObject({ kind: "stock", core: true, cb: null, dp: 2 });
    expect(stocks).toMatchObject({ enabled: true, market: { open: false, nextOpen: "2026-10-26T09:30:00-04:00" } });
    expect(parseInstruments("nope")).toEqual({ items: [], stocks: null });
    expect(deskKey("DOGE-USDT")).toBe("DOGEUSDT");
    expect(coreFeedUrl("http://127.0.0.1:4000")).toBe("ws://127.0.0.1:4000/");
  });

  it("adds only what the tape doesn't have, and core messages for those symbols are understood", () => {
    const { items } = parseInstruments(body);
    const added = addInstruments(items);
    expect(added.map((i) => i.k)).toEqual(["DOGEUSDT", "AAPL"]);
    expect(allTape().length).toBe(TAPE.length + 2);
    expect(addInstruments(items)).toEqual([]); // idempotent
    expect(deskSym("AAPL")).toBe("AAPL");
    expect(LBL.BTCUSDT!.core).toBeUndefined(); // built-ins keep the browser feed
  });

  it("reads prices from core's feed, with the stock market flag", () => {
    expect(parseCorePrice({ type: "price", symbol: "AAPL", price: 230.5, change24h: -0.4, source: "alpaca", ts: 1, marketOpen: false })).toEqual({ k: "AAPL", px: 230.5, chg: -0.4, marketOpen: false });
    expect(parseCorePrice({ type: "price", symbol: "DOGE-USDT", price: 0.2, change24h: null, source: "binance", ts: 1 })).toEqual({ k: "DOGEUSDT", px: 0.2, chg: null });
    for (const bad of [{ type: "funding", symbol: "BTC", rate: 1 }, { type: "price", symbol: "AAPL", price: -1 }, { type: "price", symbol: "a b", price: 1 }, null])
      expect(parseCorePrice(bad)).toBeNull();
  });

  it("fetches stock candles from core and drops broken rows", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => {
      asked = url;
      return { ok: true, json: async () => ({ candles: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }, { t: 2, o: 1, h: 0, l: 1, c: 1 }] }) } as Response;
    });
    expect(await fetchCoreCandles("AAPL", "5m", "http://core")).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }]);
    expect(asked).toBe("http://core/candles?symbol=AAPL&tf=5m");
  });
});

describe("the tape and chart with stocks", () => {
  const withStocks = (): DeskState => {
    addInstruments(parseInstruments(body).items);
    const s = createInitialState(1_000_000);
    return { ...s, core: "live", stocks: parseInstruments(body).stocks, live: { ...s.live, AAPL: { px: 230.5, chg: -0.4, vol: 0 }, DOGEUSDT: { px: Number.NaN, chg: 0, vol: 0 } }, market: { AAPL: false } };
  };
  it("shows core's instruments on the tape: CLOSED for a shut market, a dash before the first price", () => {
    const v = buildView(withStocks());
    expect(v.tape.find((c) => c.key === "AAPL")).toMatchObject({ sym: "AAPL", px: "230.50", chg: "CLOSED" });
    expect(v.tape.find((c) => c.key === "DOGEUSDT")).toMatchObject({ px: "—", chg: "—" });
    const open = buildView({ ...withStocks(), market: { AAPL: true } });
    expect(open.tape.find((c) => c.key === "AAPL")!.chg).toBe("-0.40%");
  });
  it("a stock chart says when the market is closed and that agents wait, and never invents candles", () => {
    const s = { ...withStocks(), chartSym: "AAPL", chartSrc: "native" as const };
    const v = buildView(s);
    expect(v.chart.isStock).toBe(true);
    expect(v.chart.marketNote).toContain("US MARKET CLOSED");
    expect(v.chart.marketNote).toContain("AGENTS WAIT FOR THE OPEN");
    expect(v.chart.feedShort).toBe("ALPACA");
    expect(v.chart.tvSrc).toContain("symbol=AAPL");
    const doge = buildView({ ...withStocks(), chartSym: "DOGEUSDT" });
    expect(doge.chart.geo.candles).toEqual([]); // no price yet, no stand-in
    expect(doge.chart.simulated).toBe(false);
  });
  it("the offline simulation keeps core's instruments instead of dropping them", () => {
    const s = withStocks();
    const next = tickState({ ...s, gotLive: false }, false);
    expect(next.live!.AAPL).toEqual(s.live.AAPL);
  });
});
