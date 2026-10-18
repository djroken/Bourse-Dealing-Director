import { afterEach, describe, expect, it, vi } from "vitest";
import { chartGeometry, simCandles, withLive } from "../lib/desk/chartgeo";
import { fetchCandles, mergeCandles, TF_MS, type Candle } from "../lib/desk/market";
import { coreSym, fetchSignals, parseIdea, parseIdeas, type Signal } from "../lib/desk/signals";
import { createInitialState, type DeskState } from "../lib/desk/state";
import { buildView } from "../lib/desk/view";

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
const stubFetch = (routes: Array<[string, () => Response]>) =>
  vi.stubGlobal("fetch", async (url: string) => {
    for (const [needle, fn] of routes) if (url.includes(needle)) return fn();
    throw new Error("offline: " + url);
  });

const M5 = TF_MS["5m"];
const candles = (n: number, t0 = 1_000_000_000_000): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * M5, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i }));
const idea = (over: Record<string, unknown> = {}) => ({
  id: "I1", ts: 1_000_000_000_000 + 2 * M5 + 10, agentId: "TKT-004", role: "Quant / Signals", name: "Pico Nandra", model: "ollama:llama3.2",
  temperature: 0.2, autonomy: "APPROVE", symbol: "BTC-USDT", side: "BUY", size: 0.01, confidence: 0.7, rationale: "momentum", price: 102,
  change24h: 1.2, source: "binance", filled: true, outcome: { horizonMs: 900000, exitPrice: 104, returnPct: 1.96, correct: true }, ...over,
});

describe("fetchCandles", () => {
  it("reads Binance klines as OHLC for the chosen timeframe", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => {
      asked = url;
      return json([[1000, "1", "3", "0.5", "2"], [2000, "2", "4", "1.5", "3"]]);
    });
    expect(await fetchCandles("BTCUSDT", "1h")).toEqual([{ t: 1000, o: 1, h: 3, l: 0.5, c: 2 }, { t: 2000, o: 2, h: 4, l: 1.5, c: 3 }]);
    expect(asked).toContain("interval=1h");
  });
  it("falls back to Coinbase (newest-first rows), merging 1h into 4h", async () => {
    const H = 3_600_000;
    // [time s, low, high, open, close, volume], newest first: 8 hourly candles from a 4h boundary
    const rows = Array.from({ length: 8 }, (_, i) => [(4 * H * 100 + i * H) / 1000, 10 + i - 1, 10 + i + 1, 10 + i, 10 + i + 0.5, 1]).reverse();
    stubFetch([["coinbase", () => json(rows)]]);
    const cs = (await fetchCandles("BTCUSDT", "4h"))!;
    expect(cs).toHaveLength(2);
    expect(cs[0]).toEqual({ t: 4 * H * 100, o: 10, h: 14, l: 9, c: 13.5 });
  });
  it("drops broken rows and is null when nothing answers", async () => {
    stubFetch([["binance", () => json([[1, "x", "1", "1", "1"], [2, "1", "1", "2", "1"]])]]);
    expect(await fetchCandles("XRPUSDT", "5m")).toBeNull(); // both rows invalid, Coinbase offline
    stubFetch([]);
    expect(await fetchCandles("BNBUSDT", "5m")).toBeNull(); // no Coinbase product either
  });
  it("mergeCandles aligns to the bucket and keeps high/low", () => {
    const cs = [{ t: 0, o: 1, h: 5, l: 1, c: 2 }, { t: 10, o: 2, h: 3, l: 0.5, c: 4 }, { t: 20, o: 4, h: 4, l: 4, c: 4 }];
    expect(mergeCandles(cs, 2, 20)).toEqual([{ t: 0, o: 1, h: 5, l: 0.5, c: 4 }, { t: 20, o: 4, h: 4, l: 4, c: 4 }]);
  });
});

describe("chart geometry", () => {
  it("folds the live price into the last candle", () => {
    const cs = withLive(candles(3), 200);
    expect(cs[2]).toMatchObject({ c: 200, h: 200 });
    expect(withLive(candles(3), Number.NaN)).toEqual(candles(3));
  });
  it("lays candles left to right inside the viewBox, up candles green", () => {
    const g = chartGeometry(candles(10), null, [], M5, 0, 0);
    expect(g.candles).toHaveLength(10);
    expect(g.candles[0]!.x).toBeLessThan(g.candles[9]!.x);
    for (const c of g.candles) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(g.W);
      expect(c.wickY1).toBeLessThanOrEqual(c.bodyY);
      expect(c.wickY2).toBeGreaterThanOrEqual(c.bodyY + c.bodyH - 1);
      expect(c.up).toBe(true);
    }
    expect(g.grid).toHaveLength(4);
  });
  it("places an idea in the candle it was made in, at its price, coloured by outcome", () => {
    const sig = parseIdea(idea())!;
    const g = chartGeometry(candles(10), null, [sig], M5, 0, sig.t + 60_000);
    expect(g.markers).toHaveLength(1);
    const mk = g.markers[0]!;
    expect(mk.xPct).toBeCloseTo(25, 5); // candle 2 of 10, centred
    expect(mk).toMatchObject({ side: "BUY", state: "hit", count: 1 });
    expect(mk.lines[0]).toContain("Pico Nandra · BUY @ 102 · 70% · right +1.96% · traded");
  });
  it("groups ideas per candle and side, open until all are scored, and ignores ideas outside the window", () => {
    const a = parseIdea(idea({ id: "a", outcome: null }))!;
    const b = parseIdea(idea({ id: "b" }))!;
    const c = parseIdea(idea({ id: "c", side: "SELL", outcome: { horizonMs: 1, exitPrice: 103, returnPct: -1, correct: false } }))!;
    const old = parseIdea(idea({ id: "old", ts: 1 }))!;
    const g = chartGeometry(candles(10), null, [a, b, c, old], M5, 0, 0);
    expect(g.visibleSignals).toBe(3);
    expect(g.markers.find((m) => m.side === "BUY")).toMatchObject({ count: 2, state: "open" });
    expect(g.markers.find((m) => m.side === "SELL")).toMatchObject({ count: 1, state: "miss" });
  });
  it("survives empty and flat input", () => {
    expect(chartGeometry([], 1, [], M5, 0, 0).candles).toEqual([]);
    const flat = [{ t: 0, o: 5, h: 5, l: 5, c: 5 }];
    expect(chartGeometry(flat, null, [], M5, 0, 0).candles[0]!.bodyH).toBeGreaterThan(0);
  });
  it("simCandles is deterministic and ends on the seed price", () => {
    const a = simCandles(100, M5, 1e12);
    expect(a).toEqual(simCandles(100, M5, 1e12));
    expect(a).toHaveLength(120);
    expect(a.at(-1)!.c).toBeCloseTo(100, 6);
  });
});

describe("signals from core", () => {
  it("parses core's idea records and rejects anything else", () => {
    expect(parseIdea(idea())).toMatchObject({ k: "BTCUSDT", side: "BUY", px: 102, outcome: { correct: true, exitPx: 104 } });
    expect(parseIdea(idea({ outcome: null }))!.outcome).toBeNull();
    for (const bad of [null, 1, [], idea({ side: "HOLD" }), idea({ price: 0 }), idea({ ts: "x" }), idea({ rationale: "x".repeat(3000) }), idea({ outcome: { correct: "yes" } }), idea({ filled: 1 })])
      expect(parseIdea(bad)).toBeNull();
    expect(parseIdeas([idea(), { nope: 1 }, idea({ id: "2" })])).toHaveLength(2);
    expect(parseIdeas("x")).toEqual([]);
    expect(coreSym("SOLUSDT")).toBe("SOL-USDT");
  });
  it("fetchSignals asks core for the symbol and is empty when core is down", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => {
      asked = url;
      return json([idea(), idea({ id: "e", symbol: "ETH-USDT" })]);
    });
    expect(await fetchSignals("BTCUSDT", "http://core")).toHaveLength(1);
    expect(asked).toBe("http://core/ideas?symbol=BTC-USDT&limit=300");
    stubFetch([]);
    expect(await fetchSignals("BTCUSDT", "http://core")).toEqual([]);
  });
});

describe("chart view", () => {
  const withSignal = (): DeskState => {
    const s = createInitialState(1_000_000_000_000 + 9 * M5);
    const sig = parseIdea(idea())! as Signal;
    return { ...s, core: "live", chartSrc: "native", kl: { "BTCUSDT|5m": candles(10) }, signals: { BTCUSDT: [sig] } };
  };
  it("shows timeframes, real candles and signal markers while core is connected", () => {
    const v = buildView(withSignal());
    expect(v.chart.tfs.map((t) => t.label)).toEqual(["1M", "5M", "15M", "1H", "4H", "1D"]);
    expect(v.chart.simulated).toBe(false);
    expect(v.chart.geo.markers).toHaveLength(1);
    expect(v.chart.signalRows[0]).toMatchObject({ who: "Pico Nandra", side: "BUY", result: "+1.96%" });
    expect(v.chart.signalNote).toContain("1 agent idea");
  });
  it("hides markers when the layer is off, and has none without core", () => {
    expect(buildView({ ...withSignal(), chartSignals: false }).chart.geo.markers).toHaveLength(0);
    const off = buildView({ ...withSignal(), core: "offline" });
    expect(off.chart.geo.markers).toHaveLength(0);
    expect(off.chart.signalNote).toContain("Start core");
  });
  it("falls back to labelled simulated candles, and the TradingView interval follows the timeframe", () => {
    const s = { ...withSignal(), kl: {}, chartTf: "1h" as const };
    const v = buildView(s);
    expect(v.chart.simulated).toBe(true);
    expect(v.chart.geo.candles.length).toBe(120);
    expect(v.chart.tvSrc).toContain("interval=60");
    expect(v.chart.tvSrc).toContain("hidesidetoolbar=1");
    expect(buildView({ ...s, chartFull: true }).chart.tvSrc).toContain("hidesidetoolbar=0");
  });
});
