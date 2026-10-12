import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETUP, LBL, SCRIPT, SEED_AGENTS, TAPE } from "../lib/desk/data";
import { bookScale, capitalOf, createInitialState, rawPnl, tickState, type DeskState } from "../lib/desk/state";
import { buildView } from "../lib/desk/view";

afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const fresh = () => createInitialState(NOW);
const apply = (s: DeskState, p: Partial<DeskState>): DeskState => ({ ...s, ...p });

describe("initial state", () => {
  it("starts in demo with the eight seats, nothing halted, setup not done", () => {
    const s = fresh();
    expect(s.mode).toBe("demo");
    expect(s.agents).toHaveLength(8);
    expect(s.halted).toBe(false);
    expect(s.setup.done).toBe(false);
    expect(s.series).toHaveLength(8);
  });
  it("has a price and a label for every tape symbol", () => {
    const s = fresh();
    for (const t of TAPE) {
      expect(s.live[t.k].px, t.k).toBeGreaterThan(0);
      expect(LBL[t.k], t.k).toBeDefined();
    }
  });
  it("does not share mutable setup with the module default", () => {
    const s = fresh();
    s.setup.on["data.finnhub"] = true;
    s.setup.agentsOn[0] = false;
    expect(DEFAULT_SETUP.on["data.finnhub"]).toBeUndefined();
    expect(DEFAULT_SETUP.agentsOn[0]).toBe(true);
  });
});

describe("capital", () => {
  it("parses messy input and falls back to $100k", () => {
    expect(capitalOf({ ...DEFAULT_SETUP, capital: "$250,000" })).toBe(250000);
    expect(capitalOf({ ...DEFAULT_SETUP, capital: "1500.5" })).toBe(1500.5);
    expect(capitalOf({ ...DEFAULT_SETUP, capital: "" })).toBe(100000);
    expect(capitalOf({ ...DEFAULT_SETUP, capital: "abc" })).toBe(100000);
  });
  it("scales the $12.5M reference book", () => {
    expect(bookScale({ ...DEFAULT_SETUP, capital: "12500000" })).toBe(1);
    expect(bookScale({ ...DEFAULT_SETUP, capital: "1250000" })).toBeCloseTo(0.1);
  });
});

describe("rawPnl", () => {
  it("marks open positions to the live price", () => {
    const s = fresh();
    const i = SEED_AGENTS.findIndex((_, idx) => idx === 0);
    const before = rawPnl(i, s.live, s.ref);
    const k = Object.keys(s.live)[0];
    const moved = { ...s.live, [k]: { ...s.live[k], px: s.live[k].px * 1.1 } };
    expect(Number.isFinite(rawPnl(i, moved, s.ref))).toBe(true);
    expect(before).toBe(rawPnl(i, s.live, s.ref));
  });
});

describe("tickState", () => {
  it("keeps every price finite and positive over many ticks", () => {
    let s = fresh();
    for (let n = 0; n < 500; n++) s = apply(s, tickState(s, true));
    for (const t of TAPE) {
      expect(Number.isFinite(s.live[t.k].px), t.k).toBe(true);
      expect(s.live[t.k].px, t.k).toBeGreaterThan(0);
    }
  });

  it("caps the buffers (chat 80, fills 40, approvals 20)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1); // always play a script line
    let s = fresh();
    for (let n = 0; n < 600; n++) s = apply(s, tickState(s, true));
    expect(s.seq.length).toBeLessThanOrEqual(80);
    expect(s.fills.length).toBeLessThanOrEqual(40);
    expect(s.approvals.length).toBeLessThanOrEqual(20);
  });

  it("plays nothing while halted or with autoplay off", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const s = fresh();
    expect(tickState({ ...s, halted: true }, true).seq).toBeUndefined();
    expect(tickState(s, false).seq).toBeUndefined();
  });

  it("AUTO agents fill; everyone else goes to the approvals queue", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    let s = fresh();
    for (let n = 0; n < SCRIPT.length * 3; n++) {
      const d = tickState(s, true);
      const ev = d.seq?.at(-1);
      if (ev && ev.i !== undefined) {
        const e = SCRIPT[ev.i];
        if (e.kind === "trade" || e.kind === "intent") {
          const auto = s.agents[e.who].autonomy === "AUTO";
          expect(ev.queued, `script ${ev.i}`).toBe(!auto);
          expect(d.fills !== undefined, `script ${ev.i} fill`).toBe(auto);
          expect(d.approvals !== undefined, `script ${ev.i} approval`).toBe(!auto);
        }
      }
      s = apply(s, d);
    }
  });

  it("a paused agent's sparkline stops moving", () => {
    const s = fresh();
    s.agents[0] = { ...s.agents[0], paused: true };
    expect(tickState(s, false).series![0]).toEqual(s.series[0]);
    expect(tickState(s, false).series![1]).not.toEqual(s.series[1]);
  });
});

describe("view", () => {
  it("never claims a real engine, real news or live routing", () => {
    const v = buildView(fresh());
    const text = JSON.stringify(v);
    expect(v.engineState).toBe("SIMULATED FLOOR");
    expect(v.modeLabel).toContain("PAPER ONLY");
    expect(v.centerMeta).toContain("SIMULATED");
    expect(text).not.toContain("ENGINE LIVE");
    expect(text).not.toContain("bourse-core 0.9");
    expect(text).not.toContain("S-2291");
    expect(v.isLive).toBe(false);
  });
  it("switches to the mobile layout below 760px", () => {
    expect(buildView({ ...fresh(), vw: 759 }).isMobile).toBe(true);
    expect(buildView({ ...fresh(), vw: 760 }).isMobile).toBe(false);
  });
  it("builds a roster with one card per seat on the floor", () => {
    const s = fresh();
    expect(buildView(s).roster).toHaveLength(8);
    const off = { ...s, setup: { ...s.setup, agentsOn: s.setup.agentsOn.map((_, i) => i !== 3) } };
    expect(buildView(off).roster).toHaveLength(7);
  });
});
