import { describe, expect, it } from "vitest";
import { leagueView, parseLeague } from "../lib/desk/league";

const raw = {
  scored: 64, source: "log+session",
  rows: [
    { model: "openrouter-free:deepseek/deepseek-chat:free", ideas: 40, hits: 24, hitRate: 0.6, avgReturnPct: 0.0812, seats: ["Quant / Signals"], firstAt: 1, lastAt: 2 },
    { model: "stub rule", ideas: 21, hits: 9, hitRate: 9 / 21, avgReturnPct: -0.02, seats: ["Execution Trader", "Market Maker"], firstAt: 1, lastAt: 2 },
    { model: "ollama:qwen3", ideas: 3, hits: 3, hitRate: 1, avgReturnPct: 0.5, seats: [], firstAt: 1, lastAt: 2 },
    { model: "x".repeat(200), ideas: 1, hits: 1, hitRate: 1, avgReturnPct: 1, seats: [], firstAt: 1, lastAt: 2 },
  ],
};

describe("model league", () => {
  it("parses core's rows, dropping malformed ones", () => {
    expect(parseLeague(raw)!.rows.map((r) => r.model)).toEqual(["openrouter-free:deepseek/deepseek-chat:free", "stub rule", "ollama:qwen3"]);
    expect(parseLeague({ rows: "x" })).toBeNull();
  });
  it("formats ranks, providers and small samples, and says what the numbers mean", () => {
    const v = leagueView(parseLeague(raw))!;
    expect(v.rows.map((r) => [r.rank, r.model, r.kind, r.hit, r.avg, r.small])).toEqual([
      ["1", "deepseek/deepseek-chat:free", "OPENROUTER FREE", "60%", "+0.081%", false],
      ["2", "stub rule", "BASELINE", "43%", "-0.020%", false],
      ["3", "qwen3", "OLLAMA", "100%", "+0.500%", true],
    ]);
    expect(v.rows[2]!.hitColor).toBe("var(--c7C8894)"); // 3 ideas: grey, not a green "100%"
    expect(v.note).toContain("64 scored ideas across every session");
    expect(leagueView({ rows: [], scored: 0, source: "session" })!.note).toMatch(/^No scored ideas yet/);
  });
});
