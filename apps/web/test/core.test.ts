import { describe, expect, it } from "vitest";
import { AgentChatMsgSchema, AgentConfigMsgSchema, AgentDecisionSchema, AgentIntentSchema, AgentLifecycleSchema, AgentPnlSchema, defaultAgents } from "../../../packages/shared/src";
import { SEED_AGENTS } from "../lib/desk/data";
import { applyCoreMsg, coreFloorUrl, deskSym, onCoreConnected, onCoreLost, parseCoreMsg, seatOf } from "../lib/desk/core";
import { createInitialState, tickState, type DeskState } from "../lib/desk/state";
import { buildView } from "../lib/desk/view";

const base = (): DeskState => createInitialState(1_000_000);
const seat = (name: string) => SEED_AGENTS.findIndex((a) => a.name.startsWith(name));
const roleOf = (name: string) => defaultAgents.find((a) => a.name.startsWith(name))!.role;
const intent = (name: string, over: Record<string, unknown> = {}) => ({
  type: "intent", agentId: "TKT-004", role: roleOf(name), symbol: "BTC-USDT", side: "BUY", size: 2, confidence: 0.6, rationale: "stub", ts: 5, ...over,
});
const decision = (name: string, over: Record<string, unknown> = {}) => ({
  type: "decision", agentId: "TKT-002", role: roleOf(name), symbol: "ETH-USDT", action: "SELL", size: 3, price: 3400, rationale: "Within risk limits", riskChecked: true, ts: 6, ...over,
});

const pnl = (name: string, over: Record<string, unknown> = {}) => ({
  type: "pnl", agentId: "TKT-002", role: roleOf(name), pnl: -125.5, exposure: 4800,
  positions: [{ symbol: "BTC-USDT", qty: -0.05, avgPx: 96000 }], ts: 7, ...over,
});

describe("roster contract with core", () => {
  it("core's seats are the Desk's seats: same name, role, model, temperature and autonomy, in the same order", () => {
    expect(defaultAgents).toHaveLength(SEED_AGENTS.length);
    defaultAgents.forEach((c, i) => {
      const d = SEED_AGENTS[i]!;
      expect(c.name).toBe(d.name);
      expect(c.role.toUpperCase()).toBe(d.role);
      expect(c.model).toBe(d.model);
      expect(c.temperature).toBe(d.temp);
      expect(c.autonomy).toBe(d.autonomy);
      expect(c.mandate).toBe(d.mandate);
    });
  });
  it("every seat resolves from its core role", () => {
    const s = base();
    defaultAgents.forEach((c, i) => expect(seatOf(s, c.role)).toBe(i));
  });
});

describe("parseCoreMsg", () => {
  it("accepts exactly what the shared schemas define", () => {
    const msgs = [
      AgentLifecycleSchema.parse({ type: "lifecycle", agentId: "TKT-001", role: "Dealing Director", status: "running", ts: 1 }),
      AgentIntentSchema.parse(intent("Pico")),
      AgentDecisionSchema.parse(decision("Atlas")),
      AgentPnlSchema.parse(pnl("Atlas")),
    ];
    for (const m of msgs) expect(parseCoreMsg(m), m.type).toMatchObject({ type: m.type });
  });
  it.each([
    null, 5, "x", [], {}, { type: "lifecycle" },
    { type: "lifecycle", agentId: "a", role: "r", status: "exploded", ts: 1 },
    intent("Pico", { side: "YOLO" }), intent("Pico", { size: -1 }), intent("Pico", { size: Number.NaN }), intent("Pico", { symbol: 7 }),
    pnl("Atlas", { exposure: -1 }), pnl("Atlas", { pnl: Number.NaN }), pnl("Atlas", { positions: "none" }), pnl("Atlas", { positions: [{ symbol: "BTC-USDT", qty: "x", avgPx: 1 }] }),
    pnl("Atlas", { positions: Array.from({ length: 40 }, () => ({ symbol: "BTC-USDT", qty: 1, avgPx: 1 })) }),
    decision("Atlas", { price: 0 }), decision("Atlas", { riskChecked: "yes" }), decision("Atlas", { rationale: "x".repeat(5000) }),
    { ...intent("Pico"), type: "order" },
  ])("rejects %j", (bad) => expect(parseCoreMsg(bad)).toBeNull());
});

describe("applyCoreMsg", () => {
  it("a SUGGEST seat's intent goes to the approvals queue in raw units, replacing its older one", () => {
    let s = onCoreConnected(base(), 1) as Partial<DeskState> as DeskState;
    s = { ...base(), ...s };
    const p1 = applyCoreMsg(s, parseCoreMsg(intent("Pico", { size: 2, ts: 10 }))!)!;
    s = { ...s, ...p1 };
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]).toMatchObject({ who: seat("Pico"), side: "BUY", k: "BTCUSDT", q: 2, raw: true, kind: "SUGGEST" });
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(intent("Pico", { size: 4, ts: 20 }))!)! };
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]!.q).toBe(4);
  });
  it("ignores HOLD intents, AUTO seats' intents, unknown symbols and unknown roles", () => {
    const s = base();
    expect(applyCoreMsg(s, parseCoreMsg(intent("Pico", { side: "HOLD", size: 0 }))!)).toBeNull();
    expect(applyCoreMsg(s, parseCoreMsg(intent("Atlas"))!)).toBeNull();
    expect(applyCoreMsg(s, parseCoreMsg(intent("Pico", { symbol: "DOGE-USDT" }))!)).toBeNull();
    expect(applyCoreMsg(s, parseCoreMsg(intent("Pico", { role: "Janitor" }))!)).toBeNull();
  });
  it("a checked decision becomes a raw paper fill and a chat line", () => {
    const s = base();
    const p = applyCoreMsg(s, parseCoreMsg(decision("Atlas"))!)!;
    expect(p.fills![0]).toMatchObject({ side: "SELL", k: "ETHUSDT", q: 3, px: 3400, raw: true, agent: "Atlas Reyner" });
    expect(p.seq!.at(-1)!.sysText).toMatch(/Atlas · SELL ETH-PERP 3\.00 @ 3,400\.0 · paper/);
  });
  it("a vetoed decision is reported and never becomes a fill", () => {
    const p = applyCoreMsg(base(), parseCoreMsg(decision("Atlas", { action: "HOLD", size: 0, riskChecked: false, rationale: "Daily loss stop reached: vetoed" }))!)!;
    expect(p.fills).toBeUndefined();
    expect(p.seq!.at(-1)!.sysText).toMatch(/vetoed by the risk gate/);
  });
  it("floor lifecycle drives HALT; per-seat lifecycle is ignored (pause arrives in config)", () => {
    const s = base();
    expect(applyCoreMsg(s, parseCoreMsg({ type: "lifecycle", agentId: "*", role: "floor", status: "halted", ts: 1 })!)).toEqual({ halted: true });
    expect(applyCoreMsg(s, parseCoreMsg({ type: "lifecycle", agentId: "TKT-002", role: "Execution Trader", status: "halted", ts: 1 })!)).toBeNull();
  });
});

const config = (name: string, over: Record<string, unknown> = {}) => ({
  type: "config", agentId: "TKT-004", role: roleOf(name), name: "Pico Nandra", model: "o4-mini", temperature: 0.2, autonomy: "AUTO",
  mandate: "Be careful.", paused: true, riskLimits: { maxClip: 4000, maxLeverage: 5, dailyLossStop: 300 }, ts: 9, ...over,
});

describe("core config", () => {
  it("matches the shared schema and rejects malformed config", () => {
    expect(parseCoreMsg(AgentConfigMsgSchema.parse(config("Pico")))).toMatchObject({ type: "config" });
    for (const bad of [config("Pico", { autonomy: "YOLO" }), config("Pico", { paused: "no" }), config("Pico", { riskLimits: { maxClip: "x" } }), config("Pico", { mandate: "x".repeat(2001) }), config("Pico", { riskLimits: null })])
      expect(parseCoreMsg(bad)).toBeNull();
  });
  it("overlays core's settings and limits onto the seat, and says the stub agents use no tokens", () => {
    const s = { ...base(), core: "live" as const };
    const p = applyCoreMsg(s, parseCoreMsg(config("Pico"))!)!;
    expect(p.agents![seat("Pico")]).toMatchObject({
      autonomy: "AUTO", temp: 0.2, mandate: "Be careful.", paused: true,
      maxClip: "$4.0k", leverage: "5.0x", lossStop: "-$300", tokens: "0", spend: "$0.00",
    });
    expect(p.agents![seat("Atlas")]).toEqual(s.agents[seat("Atlas")]); // other seats untouched
  });
  it("ignores a config for a seat the desk doesn't have", () => {
    expect(applyCoreMsg(base(), parseCoreMsg(config("Pico", { role: "Janitor" }))!)).toBeNull();
  });
});

describe("core P&L", () => {
  const live = (): DeskState => ({ ...base(), core: "live" });
  it("stores a seat's book, drops symbols the desk doesn't list", () => {
    const m = parseCoreMsg(pnl("Atlas", { positions: [{ symbol: "BTC-USDT", qty: -0.05, avgPx: 96000 }, { symbol: "DOGE-USDT", qty: 9, avgPx: 1 }] }))!;
    const p = applyCoreMsg(live(), m)!;
    expect(p.coreBook![seat("Atlas")]).toEqual({ pnl: -125.5, exposure: 4800, positions: [{ k: "BTCUSDT", qty: -0.05 }] });
  });
  it("the roster shows core's numbers (and a short suffix from the net position), not the seeded ones", () => {
    let s = live();
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(pnl("Atlas"))!)! };
    const card = buildView(s).roster.find((c) => c.name === "Atlas Reyner")!;
    expect(card.pnl).toBe("-$125");
    expect(card.exposure).toMatch(/S$/);
    const quiet = buildView(s).roster.find((c) => c.name === "Vega Ostrowski")!;
    expect([quiet.pnl, quiet.exposure]).toEqual(["—", "—"]);
  });
  it("session P&L and NAV in the header are core's too", () => {
    let s = live();
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(pnl("Atlas", { pnl: 300 }))!)! };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(pnl("Kite", { agentId: "TKT-003", pnl: -100 }))!)! };
    expect(buildView(s).pnlStr).toBe("+$200");
  });
  it("sparklines follow core's P&L while connected", () => {
    let s = live();
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(pnl("Atlas", { pnl: 50 }))!)! };
    const next = tickState(s, true).series![seat("Atlas")]!;
    expect(next.at(-1)).toBe(50);
  });
});

describe("connection lifecycle", () => {
  it("connecting wipes the scripted demo content; the simulation then stops playing", () => {
    const s0 = base();
    expect(s0.fills.length).toBeGreaterThan(0);
    const s: DeskState = { ...s0, ...onCoreConnected(s0, 5) };
    expect(s.core).toBe("live");
    expect(s.fills).toEqual([]);
    expect(s.approvals).toEqual([]);
    expect(s.coreBook).toEqual({});
    expect(s.series.every((ser) => ser.every((v) => v === 0))).toBe(true);
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) seen.add(tickState(s, true).seq?.length ?? -1);
    expect(seen).toEqual(new Set([-1])); // never plays a scripted line
  });
  it("losing core says so once, and the simulation resumes", () => {
    const live: DeskState = { ...base(), core: "live" };
    const lost = onCoreLost(live, 9, "live");
    expect(lost.core).toBe("offline");
    expect(lost.seq!.at(-1)!.sysText).toMatch(/Lost connection/);
    expect(onCoreLost(base(), 9, "connecting")).toEqual({ core: "offline" }); // never connected: say nothing
  });
});

describe("helpers", () => {
  it("builds the websocket URL", () => {
    expect(coreFloorUrl("http://127.0.0.1:4000")).toBe("ws://127.0.0.1:4000/agents");
    expect(coreFloorUrl("https://core.example/")).toBe("wss://core.example/agents");
  });
  it("maps core symbols to desk keys and refuses unknown ones", () => {
    expect(deskSym("SOL-USDT")).toBe("SOLUSDT");
    expect(deskSym("constructor")).toBeNull();
    expect(deskSym("USD-EUR")).toBeNull();
  });
});

describe("guest agents (MCP)", () => {
  const guestDecision = (over: Record<string, unknown> = {}) => ({
    type: "decision", agentId: "GST-001", role: "Guest: Claude Bot", symbol: "BTC-USDT", action: "BUY", size: 0.05, price: 96000, rationale: "Placed by Claude Bot · within risk limits", riskChecked: true, ts: 9, ...over,
  });
  it("parses a chat line and rejects empty or oversized ones", () => {
    const chat = { type: "chat", agentId: "GST-001", role: "Guest: Claude Bot", name: "Claude Bot", text: "Fading the dip", ts: 8 };
    expect(AgentChatMsgSchema.safeParse(chat).success).toBe(true);
    expect(parseCoreMsg(chat)).toMatchObject({ type: "chat", name: "Claude Bot" });
    expect(parseCoreMsg({ ...chat, text: "   " })).toBeNull();
    expect(parseCoreMsg({ ...chat, text: "x".repeat(501) })).toBeNull();
  });
  it("a guest's fill lands in the blotter and chat, labelled as a guest, without touching the roster", () => {
    const s = base();
    const patch = applyCoreMsg(s, parseCoreMsg(guestDecision())!)!;
    expect(patch.fills![0]).toMatchObject({ agent: "Claude Bot (guest)", side: "BUY", k: "BTCUSDT", raw: true });
    expect(patch.seq!.at(-1)!.sysText).toContain("GUEST Claude Bot · BUY");
    expect(patch.agents).toBeUndefined();
  });
  it("a guest's rejected order and chat show as system lines", () => {
    const s = base();
    const veto = applyCoreMsg(s, parseCoreMsg(guestDecision({ action: "HOLD", size: 0, riskChecked: false, rationale: "Order is over the $5000 clip: not placed" }))!)!;
    expect(veto.seq!.at(-1)!.sysText).toContain("rejected by the risk gate");
    const say = applyCoreMsg(s, parseCoreMsg({ type: "chat", agentId: "GST-001", role: "Guest: Claude Bot", name: "Claude Bot", text: "hello", ts: 1 })!)!;
    expect(say.seq!.at(-1)!.sysText).toBe("GUEST Claude Bot: hello");
  });
  it("a guest's seat messages (config, pnl, intent) are ignored", () => {
    const s = base();
    for (const m of [
      { type: "pnl", agentId: "GST-001", role: "Guest: Claude Bot", pnl: 5, exposure: 100, positions: [], ts: 1 },
      { type: "lifecycle", agentId: "GST-001", role: "Guest: Claude Bot", status: "running", ts: 1 },
    ]) expect(applyCoreMsg(s, parseCoreMsg(m)!)).toBeNull();
  });
});
