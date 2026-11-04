import { describe, expect, it } from "vitest";
import { lessonLines, parseLessons } from "../lib/desk/lessons";
import { talkTags } from "../lib/desk/view";

describe("lessons from core", () => {
  it("parses, keeps a seat's newest five by role, and drops junk", () => {
    const raw = { lessons: [
      ...Array.from({ length: 7 }, (_, i) => ({ agentId: "TKT-004", role: "Quant / Signals", text: `note ${i}`, right: i % 2, of: 1, ts: Date.UTC(2026, 10, 4, 22, i), model: "ollama:qwen3" })),
      { agentId: "TKT-003", role: "Market Maker", text: "other seat", ts: 1 },
      { agentId: "X", role: "Quant / Signals", text: "y".repeat(300), ts: 2 },
    ] };
    const rows = lessonLines(parseLessons(raw), "QUANT / SIGNALS");
    expect(rows.map((r) => r.text)).toEqual(["note 6", "note 5", "note 4", "note 3", "note 2"]);
    expect(rows[0]).toMatchObject({ when: "11-04 22:06", score: "0 of 1 right" });
    expect(parseLessons({ lessons: "x" })).toEqual([]);
  });
  it("a lesson line in the chat is tagged LESSON", () => {
    expect(talkTags({ t: 1, say: "x", lesson: true, mood: "cautious" })!.map((t) => t.label)).toEqual(["LESSON", "CAUTIOUS"]);
  });
});
