import { describe, expect, it } from "vitest";
import { AgentChatMsgSchema, AgentConfigMsgSchema, AgentDecisionSchema, AgentIntentSchema, AgentLifecycleSchema, AgentPnlSchema, AgentScorecardSchema, NewsMsgSchema, defaultAgents } from "../../../packages/shared/src";
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
  it("overlays core's settings and limits onto the seat; a stub-rule seat shows no model usage", () => {
    const s = { ...base(), core: "live" as const };
    const p = applyCoreMsg(s, parseCoreMsg(config("Pico"))!)!;
    expect(p.agents![seat("Pico")]).toMatchObject({
      autonomy: "AUTO", temp: 0.2, mandate: "Be careful.", paused: true,
      maxClip: "$4.0k", leverage: "5.0x", lossStop: "-$300", tokens: "—", spend: "—",
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
    expect(onCoreLost(base(), 9, "connecting")).toEqual({ core: "offline", scores: {}, signals: {}, news: [] }); // never connected: say nothing
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

describe("scorecards", () => {
  const card = (name: string, over: Record<string, unknown> = {}) => ({
    type: "scorecard", agentId: "TKT-004", role: roleOf(name), name: defaultAgents.find((a) => a.name.startsWith(name))!.name, model: "ollama:llama3.2",
    ideas: 12, holds: 3, scored: 10, hits: 6, hitRate: 0.6, avgReturnPct: 0.42, fills: 4, vetoes: 1, notional: 9000,
    closes: 2, wins: 1, winRate: 0.5, realized: 40, pnl: 55.5, peakPnl: 80, maxDrawdown: 31, updatedAt: 5, ts: 6, ...over,
  });
  it("matches the shared schema; malformed ones are rejected", () => {
    expect(AgentScorecardSchema.safeParse(card("Pico")).success).toBe(true);
    expect(parseCoreMsg(card("Pico"))).toMatchObject({ type: "scorecard", hitRate: 0.6, pnl: 55.5 });
    expect(parseCoreMsg(card("Pico", { hitRate: null, winRate: null, avgReturnPct: null }))).toMatchObject({ hitRate: null });
    for (const bad of [card("Pico", { hitRate: 1.5 }), card("Pico", { ideas: -1 }), card("Pico", { maxDrawdown: -3 }), card("Pico", { pnl: Number.NaN }), card("Pico", { winRate: "50%" }), card("Pico", { name: 7 })])
      expect(parseCoreMsg(bad)).toBeNull();
  });
  it("is stored by core agent id (guests too), and the SCORES tab lists seats in roster order then guests", () => {
    let s: DeskState = { ...base(), core: "live" };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(card("Pico", { agentId: "TKT-006" }))!)! };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(card("Pico", { agentId: "GST-001", role: "Guest: Claude Bot", name: "Claude Bot", model: "external agent (MCP)" }))!)! };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(card("Atlas", { agentId: "TKT-002", hitRate: 0.3, pnl: -12, scored: 10 }))!)! };
    expect(Object.keys(s.scores)).toHaveLength(3);
    const v = buildView({ ...s, tab: "scores" });
    expect(v.tabs.map((t) => t.label)).toContain("SCORES");
    expect(v.scores.map((r) => r.name)).toEqual([s.agents[seat("Atlas")]!.name, s.agents[seat("Pico")]!.name, "Claude Bot"]);
    const atlas = v.scores[0]!;
    expect(atlas).toMatchObject({ hit: "30% of 10", pnl: "-$12", dd: "-$31", win: "50% of 2" });
    expect(v.scores[2]).toMatchObject({ guest: true, sub: "GUEST · MCP" });
    expect(v.exportUrl).toMatch(/\/export\/ideas\.jsonl$/);
  });
  it("the drawer shows the selected seat's track record only while core is connected", () => {
    let s: DeskState = { ...base(), core: "live", sel: seat("Pico") };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(card("Pico"))!)! };
    expect(buildView(s).sel!.track).toMatchObject({ hit: "60%", hitNote: "6 of 10 ideas", win: "50%", pnl: "+$56", dd: "-$31", ideas: "12", fills: "4" });
    expect(buildView({ ...s, core: "offline" }).sel!.track).toBeNull();
    expect(buildView({ ...s, core: "offline" }).scores).toEqual([]);
  });
  it("connecting and losing core both clear the scores", () => {
    const s: DeskState = { ...base(), core: "live", scores: { X: { agentId: "X" } as DeskState["scores"][string] } };
    expect(onCoreConnected(s, 1).scores).toEqual({});
    expect(onCoreLost(s, 1, "live").scores).toEqual({});
  });
  it("a long model id (up to core's 96 characters) still updates the seat", () => {
    const id = "openrouter:" + "v".repeat(85);
    expect(parseCoreMsg(config("Pico", { model: id }))).toMatchObject({ model: id });
  });
});

describe("floor conversation", () => {
  const chat = (over: Record<string, unknown>) => ({ type: "chat", agentId: "TKT-004", role: roleOf("Pico"), name: "Pico Nandra", text: "SOL momentum is clean.", ts: 7, round: "Tabc", ...over });
  it("a seat's line joins the floor chat with its name, role and who wrote it", () => {
    let s: DeskState = { ...base(), core: "live" };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(AgentChatMsgSchema.parse(chat({ model: "ollama:llama3.2" }))!)!) };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(chat({ agentId: "TKT-007", role: roleOf("Bastion"), name: "Bastion Cole", text: "No open risk.", stub: true }))!)! };
    const rows = buildView(s).chat.slice(-2);
    expect(rows[0]).toMatchObject({ kind: "msg", who: "Pico", text: "SOL momentum is clean." });
    expect(rows[0]!.role).toContain("ollama:llama3.2");
    expect(rows[1]!.role).toContain("STUB RULE");
  });
  it("the owner's echoed words show as YOU; unknown seats are ignored", () => {
    const s = base();
    const p = applyCoreMsg(s, parseCoreMsg(chat({ agentId: "OWNER", role: "Owner", name: "YOU", text: "flatten SOL" }))!)!;
    expect(p.seq!.at(-1)).toMatchObject({ user: "flatten SOL" });
    expect(applyCoreMsg(s, parseCoreMsg(chat({ role: "Janitor" }))!)).toBeNull();
  });
  it("the strip and footer say how many seats run a model, instead of always 'stub agents'", () => {
    const s: DeskState = { ...base(), core: "live" };
    expect(buildView({ ...s, agents: s.agents.map((a) => ({ ...a, model: "stub" })) }).strip).toContain("stub agents (not AI)");
    const mixed = { ...s, agents: s.agents.map((a, i) => ({ ...a, model: i < 3 ? "ollama:llama3.2" : "stub" })) };
    expect(buildView(mixed).strip).toContain("3 model + 5 stub agents");
    expect(buildView(mixed).runtimeLabel).toBe("RUNTIME BOURSE CORE (3 MODEL / 5 STUB)");
  });
  it("usage messages become the drawer's real counters", () => {
    const s = base();
    const u = { type: "usage", agentId: "TKT-004", role: roleOf("Pico"), callsToday: 12, tokensToday: 18_460, spendToday: 0.0042, latencyMs: 1830, ts: 1 };
    const p = applyCoreMsg(s, parseCoreMsg(u)!)!;
    expect(p.agents![seat("Pico")]).toMatchObject({ tokens: "18.5k", spend: "$0.0042", latency: "1.8s" });
    expect(applyCoreMsg(s, parseCoreMsg({ ...u, spendToday: null })!)!.agents![seat("Pico")]!.spend).toBe("n/a");
    expect(parseCoreMsg({ ...u, tokensToday: -1 })).toBeNull();
  });
  it("core's needsApproval decides the queue, so a model seat on AUTO still reaches the owner", () => {
    const s = base(); // Atlas is AUTO in the seed roster
    const auto = intent("Atlas", { needsApproval: true, rationale: "ollama:x in floor talk: buy" });
    expect(applyCoreMsg(s, parseCoreMsg(auto)!)!.approvals!.filter((a) => a.raw)).toHaveLength(1);
    expect(applyCoreMsg(s, parseCoreMsg(intent("Pico", { needsApproval: false }))!)).toBeNull();
    expect(applyCoreMsg(s, parseCoreMsg(intent("Atlas"))!)).toBeNull(); // older core: AUTO means a decision follows
  });
  it("the drawer explains the counters for a stub seat and a model seat", () => {
    const s: DeskState = { ...base(), core: "live", sel: seat("Pico") };
    expect(buildView(s).sel!.usageNote).toContain("stub rule");
    const m = { ...s, agents: s.agents.map((a, i) => (i === seat("Pico") ? { ...a, model: "ollama:llama3.2" } : a)) };
    expect(buildView(m).sel!.usageNote).toContain("counted by core");
  });
});

describe("broker paper fills", () => {
  const decision = (over: Record<string, unknown> = {}) => ({
    type: "decision", agentId: "TKT-004", role: roleOf("Pico"), symbol: "BTC-USDT", action: "BUY", size: 0.01234, price: 96_500, riskChecked: true,
    rationale: "Approved by operator · filled on Binance testnet, order 42 · within risk limits", venue: "binance-testnet", venueOrderId: "42", ts: 5, ...over,
  });
  it("a broker fill says where it filled, in the chat and the blotter", () => {
    expect(AgentDecisionSchema.safeParse(decision()).success).toBe(true);
    const s = base();
    const p = applyCoreMsg(s, parseCoreMsg(decision())!)!;
    expect(p.fills![0]).toMatchObject({ venue: "binance-testnet", q: 0.01234, px: 96_500 });
    expect(p.seq!.at(-1)!.sysText).toContain("Binance testnet (play money) · risk checked");
    expect(buildView({ ...s, ...p }).fills[0]!.status).toBe("TESTNET");
    const paper = applyCoreMsg(s, parseCoreMsg(decision({ venue: undefined }))!)!;
    expect(paper.seq!.at(-1)!.sysText).toContain(" · paper · risk checked");
    expect(buildView({ ...s, ...paper }).fills[0]!.status).toBe("PAPER");
  });
  it("a broker refusal is reported as not filled, not as a risk veto; unknown venues are dropped", () => {
    const s = base();
    const p = applyCoreMsg(s, parseCoreMsg(decision({ action: "HOLD", size: 0, riskChecked: false, rationale: "Binance testnet refused the order: insufficient balance" }))!)!;
    expect(p.seq!.at(-1)!.sysText).toContain("not filled: Binance testnet refused the order: insufficient balance");
    expect(parseCoreMsg(decision({ venue: "binance-live" }))).not.toHaveProperty("venue");
  });
});

describe("headlines from core", () => {
  const news = (over: Record<string, unknown> = {}) => ({
    type: "news", id: "abc123", source: "CoinDesk", title: "Bitcoin ETF inflows hit $1.2B", url: "https://www.coindesk.com/a", publishedAt: 1_000_000 - 12 * 60_000,
    tag: "FLOW", symbols: ["BTC-USDT"], ts: 1_000_000, ...over,
  });
  it("replace the sample in the news panel, newest first, once each, labelled unverified", () => {
    expect(NewsMsgSchema.safeParse(news()).success).toBe(true);
    let s: DeskState = { ...base(), core: "live" };
    expect(buildView(s).news).toMatchObject({ label: "WAITING FOR FEEDS", rows: [] });
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(news())!)! };
    s = { ...s, ...applyCoreMsg(s, parseCoreMsg(news({ id: "new1", title: "Fed holds rates", tag: "MACRO", symbols: [], publishedAt: 1_000_000 - 60_000 }))!)! };
    expect(applyCoreMsg(s, parseCoreMsg(news())!)).toBeNull(); // already shown
    const v = buildView(s).news;
    expect(v.label).toBe("LIVE HEADLINES · UNVERIFIED");
    expect(v.rows.map((r) => [r.headline, r.age, r.foot])).toEqual([["Fed holds rates", "1m", "CoinDesk"], ["Bitcoin ETF inflows hit $1.2B", "12m", "CoinDesk · names BTC"]]);
    expect(buildView(base()).news.label).toBe("SAMPLE HEADLINES");
    expect({ ...s, ...onCoreLost(s, 2, "live") }.news).toEqual([]);
  });
  it("only http(s) links survive and malformed headlines are dropped", () => {
    expect(parseCoreMsg(news({ url: "javascript:alert(1)" }))).toMatchObject({ url: null });
    expect(parseCoreMsg(news({ tag: "SPAM" }))).toBeNull();
    expect(parseCoreMsg(news({ title: "x".repeat(201) }))).toBeNull();
    expect(parseCoreMsg(news({ title: "   " }))).toBeNull();
  });
});
