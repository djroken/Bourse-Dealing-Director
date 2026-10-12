import { describe, expect, it } from "vitest";
import { DEFAULT_SETUP, LIVE_AVAILABLE, VENUES, type Setup } from "../lib/desk/data";
import { STEPS, isSecretVal, keyOf, persistable, valKey } from "../lib/desk/onboarding";
import { venuesReady } from "../lib/desk/state";

describe("live trading is not available", () => {
  // Tripwire. Bourse has no execution layer: nothing can place a real order. If you are flipping this flag,
  // you are claiming real orders can be routed, so build the execution layer, the server-side key store and a hard
  // risk gate first, then update this test and the README together.
  it("LIVE_AVAILABLE stays false until an execution layer exists", () => {
    expect(LIVE_AVAILABLE).toBe(false);
  });

  it("no venue can be ready, even from a hostile saved setup with keys filled in", () => {
    const hostile: Setup = {
      ...DEFAULT_SETUP,
      on: { ...DEFAULT_SETUP.on, ...Object.fromEntries(VENUES.map((v) => [`venue.${v.id}`, true])) },
      vals: Object.fromEntries(VENUES.map((v) => [`venue.${v.id}.${v.field}`, "0xdeadbeef"])),
    };
    expect(venuesReady(hostile)).toEqual([]);
  });

  it("every non-paper venue in onboarding is a placeholder", () => {
    const venues = STEPS.find((s) => s.id === "venue")!;
    for (const it of venues.items) {
      if (it.id === "paper") expect(it.locked).toBe(true);
      else expect(it.soon, it.name).toBe(true);
    }
  });
});

describe("secrets never reach localStorage", () => {
  it("every password-type field is treated as a secret", () => {
    for (const st of STEPS)
      for (const it of st.items)
        for (const f of it.fields) expect(isSecretVal(valKey(st, it, f)), valKey(st, it, f)).toBe(f.type === "password");
  });

  it("persistable() strips secret values and keeps the rest", () => {
    const setup: Setup = {
      ...DEFAULT_SETUP,
      vals: {
        "runtime.claude.key": "sk-ant-SECRET",
        "model.anthropic.key": "sk-ant-ALSO-SECRET",
        "model.ollama.host": "http://localhost:11434",
        "data.tradingview.pass": "hunter2",
        "venue.binance.key": "bnb-SECRET",
        "venue.binance.secret": "bnb-SECRET2",
        "venue.hyperliquid.addr": "0xabc",
      },
    };
    const saved = persistable(setup);
    const text = JSON.stringify(saved);
    for (const s of ["SECRET", "hunter2", "ALSO"]) expect(text).not.toContain(s);
    expect(saved.vals["model.ollama.host"]).toBe("http://localhost:11434");
    expect(saved.vals["venue.hyperliquid.addr"]).toBe("0xabc");
    expect(saved.autonomy).toBe(setup.autonomy);
    // and it does not mutate its input
    expect(setup.vals["runtime.claude.key"]).toBe("sk-ant-SECRET");
  });

  it("value keys line up with what venuesReady will read, for when venues go live", () => {
    const venues = STEPS.find((s) => s.id === "venue")!;
    for (const v of VENUES) {
      const item = venues.items.find((i) => i.id === v.id)!;
      expect(item, v.id).toBeDefined();
      expect(item.fields.some((f) => keyOf(venues, item) + "." + f.k === `venue.${v.id}.${v.field}`), v.id).toBe(true);
    }
  });
});

describe("onboarding data", () => {
  it("has unique ids and field keys", () => {
    for (const st of STEPS) {
      expect(new Set(st.items.map((i) => i.id)).size, st.id).toBe(st.items.length);
      for (const it of st.items) expect(new Set(it.fields.map((f) => f.k)).size, it.id).toBe(it.fields.length);
    }
  });
  it("defaults only turn on options that exist", () => {
    for (const k of Object.keys(DEFAULT_SETUP.on)) {
      const [step, id] = k.split(".");
      expect(STEPS.find((s) => s.id === step)?.items.some((i) => i.id === id), k).toBe(true);
    }
  });
});
