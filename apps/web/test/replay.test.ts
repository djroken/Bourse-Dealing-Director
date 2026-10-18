import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAgents } from "../../../packages/shared/src";
import { DEFAULT_FORM, TRADING_ROLES, candlesFor, getReplay, horizonLabel, parseJob, replayView, startReplay } from "../lib/desk/replay";

afterEach(() => vi.unstubAllGlobals());

const seat = (over: Record<string, unknown> = {}) => ({
  role: "Quant / Signals", name: "Pico Nandra", model: "ollama:llama3.2", evaluated: 60, ideas: 40, holds: 20, failed: 0, hits: 22, hitRate: 0.55,
  avgReturnPct: 0.0412, pnl: 123.4, fees: 9.1, wins: 20, winRate: 0.5, maxDrawdown: 88.2, bestPct: 1.2, worstPct: -0.9, ...over,
});
const job = (over: Record<string, unknown> = {}) => ({
  id: "R1", status: "done", progress: 1, params: { symbol: "BTC-USDT", timeframe: "5m", days: 7, horizon: 3, feeBps: 5, maxModelCalls: 60 },
  seats: ["Quant / Signals"], startedAt: 1, finishedAt: 2, error: null,
  result: { from: Date.UTC(2026, 9, 10), to: Date.UTC(2026, 9, 17), candles: 2016, source: "binance", marketReturnPct: 3.21, seats: [seat()] },
  ...over,
});

describe("replay client", () => {
  it("knows the same trading seats as core", () => {
    expect([...TRADING_ROLES].sort()).toEqual(defaultAgents.filter((a) => a.trades).map((a) => a.role).sort());
  });
  it("labels horizons and counts candles", () => {
    expect(horizonLabel("5m", 3)).toBe("15m");
    expect(horizonLabel("1h", 24)).toBe("24h");
    expect(horizonLabel("15m", 6)).toBe("1.5h");
    expect(candlesFor("5m", 7)).toBe(2016);
    expect(candlesFor("1m", 30)).toBe(43200);
  });
  it("parses core's job and rejects anything else", () => {
    expect(parseJob(job())).toMatchObject({ id: "R1", status: "done", result: { candles: 2016 } });
    expect(parseJob(job({ status: "running", result: null, progress: 0.4 }))).toMatchObject({ progress: 0.4, result: null });
    for (const bad of [null, [], job({ status: "exploded" }), job({ progress: "x" }), job({ result: { ...job().result, seats: [seat({ hitRate: "55%" })] } }), job({ params: null })])
      expect(parseJob(bad)).toBeNull();
  });
  it("formats results for the table", () => {
    const v = replayView(parseJob(job()), "http://core")!;
    expect(v.rows[0]).toMatchObject({ name: "Pico Nandra", ideas: "40/60", hit: "55%", avg: "+0.041%", win: "50%", pnl: "+$123", dd: "-$88", failed: "0" });
    expect(v.summary).toContain("2,016 candles from binance");
    expect(v.summary).toContain("holding BTC returned +3.21%");
    expect(v.exportUrl).toBe("http://core/replay/R1/ideas.jsonl");
    const running = replayView(parseJob(job({ status: "running", progress: 0.42, result: null })))!;
    expect(running).toMatchObject({ busy: true, progressPct: 42, exportUrl: null });
    expect(running.statusLine).toContain("42%");
    expect(replayView(parseJob(job({ status: "failed", result: null, error: "no historical candles" })))!.error).toBe("no historical candles");
    expect(replayView(null)).toBeNull();
  });
  it("starts a replay and reports core's errors in plain words", async () => {
    let sent: unknown = null;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return { ok: true, status: 202, json: async () => job({ status: "fetching", result: null, progress: 0 }) } as Response;
    });
    const r = await startReplay(DEFAULT_FORM, "http://core");
    expect(r).toMatchObject({ ok: true, value: { status: "fetching" } });
    expect(sent).toMatchObject({ symbol: "BTC-USDT", timeframe: "5m", days: 7, horizon: 3 });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 409, json: async () => ({ error: "a replay is already running" }) }) as Response);
    expect(await startReplay(DEFAULT_FORM, "http://core")).toEqual({ ok: false, error: "a replay is already running" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect((await startReplay(DEFAULT_FORM, "http://core")) as { error: string }).toMatchObject({ ok: false, error: expect.stringContaining("isn't reachable") });
    expect(await getReplay(undefined, "http://core")).toBeNull();
  });
  it("getReplay reads the latest job or one by id", async () => {
    vi.stubGlobal("fetch", async (url: string) => ({ ok: true, json: async () => (url.endsWith("/replay") ? { job: job() } : job({ id: "R2" })) }) as Response);
    expect((await getReplay(undefined, "http://core"))!.id).toBe("R1");
    expect((await getReplay("R2", "http://core"))!.id).toBe("R2");
  });
});
