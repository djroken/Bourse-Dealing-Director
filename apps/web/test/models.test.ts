import { describe, expect, it } from "vitest";
import { customModelOk, keyLine, parseCatalog } from "../lib/desk/models";
import { applyCoreMsg, parseCoreMsg } from "../lib/desk/core";
import { createInitialState } from "../lib/desk/state";
import { SEED_AGENTS } from "../lib/desk/data";

const cat = (over: Record<string, unknown> = {}) => ({
  openrouter: { keySet: true, error: null, free: [{ id: "openrouter-free:deepseek/deepseek-chat:free", name: "DeepSeek V3 (free)" }, { id: "openrouter:paid/model", name: "sneaky" }, { id: "rm -rf /", name: "x" }] },
  ollama: { reachable: true, models: [{ id: "ollama:qwen2.5:0.5b", name: "qwen2.5:0.5b" }] },
  ...over,
});

describe("model catalog from core", () => {
  it("keeps only free OpenRouter ids in the free list and well-formed Ollama ids", () => {
    expect(parseCatalog(cat())).toEqual({
      openrouterKey: true, freeBudget: null, free: [{ id: "openrouter-free:deepseek/deepseek-chat:free", name: "DeepSeek V3 (free)" }], freeError: null,
      ollama: [{ id: "ollama:qwen2.5:0.5b", name: "qwen2.5:0.5b" }], ollamaUp: true,
    });
    expect(parseCatalog({})).toBeNull();
  });
  it("says whether the chosen provider can run, and how to fix it", () => {
    const noKey = parseCatalog(cat({ openrouter: { keySet: false, free: [] } }))!;
    expect(keyLine(noKey, "openrouter-free:x/y:free")).toMatchObject({ ok: false, text: expect.stringContaining("OPENROUTER_API_KEY") });
    expect(keyLine(parseCatalog(cat())!, "openrouter:x/y")).toEqual({ ok: true, text: "OpenRouter key: found in core." });
    expect(keyLine(parseCatalog(cat({ ollama: { reachable: false, models: [] } }))!, "ollama:llama3.2")!.ok).toBe(false);
    expect(keyLine(noKey, "gpt-5.1")).toBeNull();
    expect(keyLine(null, "ollama:x")).toBeNull();
  });
  it("free seats see the shared daily allowance, and when it's used up", () => {
    const c = (used: number) => parseCatalog(cat({ openrouter: { keySet: true, free: [], budget: { used, cap: 45 } } }))!;
    expect(keyLine(c(12), "openrouter-free:x/y:free")!.text).toContain("Free calls today: 12 of 45");
    expect(keyLine(c(12), "openrouter:paid/model")!.text).toBe("OpenRouter key: found in core.");
    expect(keyLine(c(45), "openrouter-free:x/y:free")).toMatchObject({ ok: false, text: expect.stringContaining("used up (45 of 45)") });
  });
  it("accepts custom ids only with a provider prefix", () => {
    expect(customModelOk("openrouter-free:google/gemma-3-27b-it:free")).toBe(true);
    expect(customModelOk(" ollama:llama3.2:1b ")).toBe(true);
    expect(customModelOk("deepseek-chat")).toBe(false);
    expect(customModelOk("openrouter:")).toBe(false);
  });
  it("a failed call's reason reaches the seat, and a new model clears it", () => {
    const s = createInitialState(1);
    const i = SEED_AGENTS.findIndex((a) => a.name.startsWith("Pico"));
    const u = { type: "usage", agentId: "TKT-004", role: "Quant / Signals", callsToday: 0, tokensToday: 0, spendToday: 0, latencyMs: null, lastError: "model not found", ts: 1 };
    const p = applyCoreMsg(s, parseCoreMsg(u)!)!;
    expect(p.agents![i]!.modelError).toBe("model not found");
    const s2 = { ...s, ...p };
    const cfg = { type: "config", agentId: "TKT-004", role: "Quant / Signals", name: "Pico Nandra", model: "ollama:other", temperature: 0.3, autonomy: "SUGGEST", mandate: "m", paused: false, riskLimits: { maxClip: 1, maxLeverage: 1, dailyLossStop: 1 }, ts: 2 };
    expect(applyCoreMsg(s2, parseCoreMsg(cfg)!)!.agents![i]!.modelError).toBeNull();
  });
});
