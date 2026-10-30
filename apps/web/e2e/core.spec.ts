import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** Stands in for Bourse Core's /agents stream. */
async function mockCore(page: Page) {
  const sent: string[] = [];
  let sock: WebSocketRoute | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    sock = ws;
    ws.onMessage((m) => sent.push(String(m)));
    const lc = (agentId: string, role: string) => ws.send(JSON.stringify({ type: "lifecycle", agentId, role, status: "running", ts: Date.now() }));
    lc("TKT-002", "Execution Trader");
    lc("TKT-004", "Quant / Signals");
  });
  return {
    sent,
    send: (m: unknown) => sock!.send(JSON.stringify(m)),
    raw: (text: string) => sock!.send(text),
    drop: () => void sock!.close(),
  };
}

test("with core connected the floor shows core's events instead of the scripted chat", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await expect(page.locator(".hz-footer")).toContainText("CORE FLOOR");
  await expect(page.locator(".hz-log")).toContainText("Connected to Bourse Core");
  await expect(page.locator(".hz-log")).not.toContainText("CPI"); // scripted demo lines are gone

  const now = Date.now();
  core.send({ type: "decision", agentId: "TKT-002", role: "Execution Trader", symbol: "BTC-USDT", action: "BUY", size: 3, price: 96000, rationale: "Within risk limits", riskChecked: true, ts: now });
  await expect(page.locator(".hz-log")).toContainText("Atlas · BUY BTC-PERP 3.00 @ 96,000 · paper · risk checked");

  core.send({ type: "decision", agentId: "TKT-002", role: "Execution Trader", symbol: "ETH-USDT", action: "HOLD", size: 0, price: 3400, rationale: "Daily loss stop reached: vetoed", riskChecked: false, ts: now + 1 });
  await expect(page.locator(".hz-log")).toContainText("vetoed by the risk gate");

  await page.locator(".hz-tab", { hasText: "BLOTTER" }).click();
  await expect(page.locator(".hz-blotter-body").filter({ hasText: "BTC-PERP" }).first()).toContainText("96,000");

  core.send({ type: "intent", agentId: "TKT-004", role: "Quant / Signals", symbol: "SOL-USDT", side: "SELL", size: 2, confidence: 0.5, rationale: "stub momentum", ts: now + 2 });
  await page.locator(".hz-tab", { hasText: "APPROVALS" }).click();
  await expect(page.locator(".hz-appr", { hasText: "SOL-PERP" })).toHaveCount(1);
});

test("garbage from the socket is ignored and doesn't break the desk", async ({ page, errors }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  for (const bad of ["not json {", "[]", { type: "decision", agentId: "x" }, { type: "intent", agentId: "TKT-004", role: "Quant / Signals", symbol: "BTC-USDT", side: "BUY", size: -5, confidence: 1, rationale: "", ts: 1 }]) {
    if (typeof bad === "string") core.raw(bad);
    else core.send(bad);
  }
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  expect(errors).toEqual([]);
});

test("HALT ALL tells core, and losing core falls back to the simulated floor", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.getByRole("button", { name: "HALT ALL" }).click();
  await expect.poll(() => core.sent.map((m) => JSON.parse(m).type)).toContain("halt_all");
  await page.getByRole("button", { name: "RESUME" }).click();
  await expect.poll(() => core.sent.map((m) => JSON.parse(m).type)).toContain("resume_all");

  core.drop();
  await expect(page.locator(".hz-sim")).toContainText("SIMULATED FLOOR");
  await expect(page.locator(".hz-log")).toContainText("Lost connection to Bourse Core");
});

test("with no core running the desk is the simulated floor and says so", async ({ page }) => {
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("SIMULATED FLOOR");
  await expect(page.locator(".hz-log")).not.toContainText("Bourse Core");
});

test("the roster shows core's book, and approving an idea sends one order to core", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const now = Date.now();
  core.send({ type: "pnl", agentId: "TKT-002", role: "Execution Trader", pnl: 412.4, exposure: 9100, positions: [{ symbol: "BTC-USDT", qty: 0.1, avgPx: 91000 }], ts: now });
  const atlas = page.locator(".hz-agent", { hasText: "Atlas Reyner" });
  await expect(atlas).toContainText("+$412");
  await expect(atlas).toContainText("$9.1k L");
  await expect(page.locator(".hz-agent", { hasText: "Vega Ostrowski" })).not.toContainText("$");

  core.send({ type: "intent", agentId: "TKT-004", role: "Quant / Signals", symbol: "ETH-USDT", side: "BUY", size: 0.5, confidence: 0.6, rationale: "stub momentum", ts: now + 1 });
  await page.locator(".hz-tab", { hasText: "APPROVALS" }).click();
  const card = page.locator(".hz-appr", { hasText: "ETH-PERP" });
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "PLACE ORDER" }).click();
  await expect(page.locator(".hz-appr")).toHaveCount(0);
  await expect.poll(() => core.sent.filter((m) => JSON.parse(m).type === "place_order").length).toBe(1);
  const order = JSON.parse(core.sent.find((m) => JSON.parse(m).type === "place_order")!);
  expect({ ...order, role: String(order.role).toLowerCase() }).toEqual({ type: "place_order", role: "quant / signals", symbol: "ETH-USDT", side: "BUY", size: 0.5 });
  await page.waitForTimeout(500);
  expect(core.sent.filter((m) => JSON.parse(m).type === "place_order")).toHaveLength(1); // never twice
  await page.locator(".hz-tab", { hasText: "FLOOR CHAT" }).click();
  await expect(page.locator(".hz-log")).toContainText("sent to core for the risk check");
});

const cfgMsgs = (core: { sent: string[] }) => core.sent.map((m) => JSON.parse(m)).filter((m) => m.type === "configure_agent");

test("drawer edits reach core: autonomy once, mandate debounced, pause sends paused", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.locator(".hz-agent", { hasText: "Atlas Reyner" }).click();
  const drawer = page.getByRole("dialog", { name: /Atlas Reyner settings/ });

  await drawer.getByRole("button", { name: "SUGGEST", exact: true }).click();
  await expect.poll(() => cfgMsgs(core).length).toBe(1);
  expect(cfgMsgs(core)[0]).toMatchObject({ type: "configure_agent", role: expect.stringMatching(/execution trader/i), autonomy: "SUGGEST" });

  await drawer.getByLabel("Mandate (system prompt)").fill("Only trade BTC.");
  await page.waitForTimeout(700);
  const mandates = cfgMsgs(core).filter((m) => m.mandate !== undefined);
  expect(mandates).toHaveLength(1);
  expect(mandates[0].mandate).toBe("Only trade BTC.");

  await drawer.getByRole("button", { name: "PAUSE AGENT" }).click();
  await expect.poll(() => cfgMsgs(core).some((m) => m.paused === true)).toBe(true);
  await drawer.getByRole("button", { name: "RESUME AGENT" }).click();
  await expect.poll(() => cfgMsgs(core).some((m) => m.paused === false)).toBe(true);
});

test("a core config message updates the drawer, and an echo doesn't clobber typing", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const cfg = (mandate: string) => ({
    type: "config", agentId: "TKT-002", role: "Execution Trader", name: "Atlas Reyner", model: "claude-sonnet-4-5",
    temperature: 0.3, autonomy: "AUTO", mandate, paused: false,
    riskLimits: { maxClip: 4000, maxLeverage: 3, dailyLossStop: 500 }, ts: Date.now(),
  });
  core.send(cfg("From core."));
  await page.locator(".hz-agent", { hasText: "Atlas Reyner" }).click();
  const drawer = page.getByRole("dialog", { name: /Atlas Reyner settings/ });
  await expect(drawer.getByLabel("Mandate (system prompt)")).toHaveValue("From core.");
  await expect(drawer).toContainText("$4.0k");
  await expect(drawer).toContainText("-$500");

  const box = drawer.getByLabel("Mandate (system prompt)");
  await box.fill("Half-typed edit");
  core.send(cfg("stale echo"));
  await page.waitForTimeout(150);
  await expect(box).toHaveValue("Half-typed edit");
});

test("a custom model id typed in the drawer is sent to core", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.locator(".hz-agent", { hasText: "Pico Nandra" }).click();
  const drawer = page.getByRole("dialog", { name: /Pico Nandra settings/ });
  await drawer.getByLabel("Custom model id").fill("openrouter:anthropic/claude-sonnet-4.5");
  await drawer.getByLabel("Custom model id").press("Enter");
  await expect.poll(() => cfgMsgs(core).some((m) => m.model === "openrouter:anthropic/claude-sonnet-4.5")).toBe(true);
  await drawer.getByLabel("Model", { exact: true }).selectOption("openrouter-free:meta-llama/llama-3.3-70b-instruct:free");
  await expect.poll(() => cfgMsgs(core).some((m) => m.model === "openrouter-free:meta-llama/llama-3.3-70b-instruct:free")).toBe(true);
});

test("the model picker lists core's free OpenRouter models, says when core has no key, and shows why a call failed", async ({ page }) => {
  await page.route(/127\.0\.0\.1:4000\/models\/catalog/, (r) => r.fulfill({ json: {
    openrouter: { keySet: false, error: null, fetchedAt: 1, free: [
      { id: "openrouter-free:deepseek/deepseek-chat:free", name: "DeepSeek V3 (free)", context: 64000 },
      { id: "openrouter-free:qwen/qwen3-coder:free", name: "Qwen3 Coder (free)", context: 262000 },
    ] },
    ollama: { host: "http://127.0.0.1:11434", reachable: false, models: [] },
  } }));
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.locator(".hz-agent", { hasText: "Pico Nandra" }).click();
  const drawer = page.getByRole("dialog", { name: /Pico Nandra settings/ });
  const picker = drawer.getByLabel("Model", { exact: true });
  await expect(picker.locator('optgroup[label^="OpenRouter"]')).toHaveAttribute("label", "OpenRouter · free (2)");
  await expect(picker.locator('optgroup[label^="OpenRouter"] option')).toHaveText(["DeepSeek V3 (free)", "Qwen3 Coder (free)"]);
  await picker.selectOption("openrouter-free:deepseek/deepseek-chat:free");
  await expect.poll(() => cfgMsgs(core).some((m) => m.model === "openrouter-free:deepseek/deepseek-chat:free")).toBe(true);
  await expect(drawer.getByTestId("model-key")).toContainText("core doesn't have it");
  await expect(drawer.getByTestId("model-key")).toContainText(".env");

  const custom = drawer.getByLabel("Custom model id");
  await custom.fill("deepseek-chat");
  await expect(drawer.getByRole("button", { name: "USE", exact: true })).toBeDisabled();
  await expect(drawer).toContainText("Start with ollama:, openrouter-free: or openrouter:");
  await custom.fill("openrouter-free:google/gemma-3-27b-it:free");
  await drawer.getByRole("button", { name: "USE", exact: true }).click();
  await expect.poll(() => cfgMsgs(core).some((m) => m.model === "openrouter-free:google/gemma-3-27b-it:free")).toBe(true);

  core.send({ type: "usage", agentId: "TKT-004", role: "Quant / Signals", callsToday: 0, tokensToday: 0, spendToday: 0, latencyMs: null, lastError: "no OpenRouter key: set one in Setup or OPENROUTER_API_KEY", ts: Date.now() });
  await expect(drawer.getByTestId("model-error")).toHaveText("Last call failed: no OpenRouter key: set one in Setup or OPENROUTER_API_KEY");
});

test("a guest agent's trade and chat show up on the desk, labelled as a guest", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const now = Date.now();
  core.send({ type: "chat", agentId: "GST-001", role: "Guest: Claude Bot", name: "Claude Bot", text: "Fading the dip", ts: now });
  await expect(page.locator(".hz-log")).toContainText("GUEST Claude Bot: Fading the dip");
  core.send({ type: "decision", agentId: "GST-001", role: "Guest: Claude Bot", symbol: "BTC-USDT", action: "BUY", size: 0.05, price: 96000, rationale: "Placed by Claude Bot", riskChecked: true, ts: now + 1 });
  await expect(page.locator(".hz-log")).toContainText("GUEST Claude Bot · BUY BTC-PERP 0.0500 @ 96,000 · paper");
  await page.locator(".hz-tab", { hasText: "BLOTTER" }).click();
  await expect(page.locator(".hz-blotter-body").filter({ hasText: "Claude Bot (guest)" }).first()).toContainText("96,000");
});

test("scorecards from core show in the SCORES tab and the agent drawer", async ({ page }) => {
  const core = await mockCore(page);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const card = (over: Record<string, unknown>) => ({
    type: "scorecard", agentId: "TKT-002", role: "Execution Trader", name: "Atlas Reyner", model: "claude-sonnet-4-5",
    ideas: 9, holds: 1, scored: 8, hits: 5, hitRate: 0.625, avgReturnPct: 0.31, fills: 6, vetoes: 2, notional: 12000,
    closes: 3, wins: 2, winRate: 2 / 3, realized: 40, pnl: 212.4, peakPnl: 260, maxDrawdown: 48, updatedAt: Date.now(), ts: Date.now(), ...over,
  });
  core.send(card({}));
  core.send(card({ agentId: "GST-001", role: "Guest: Claude Bot", name: "Claude Bot", model: "external agent (MCP)", hitRate: null, scored: 0, pnl: 0, fills: 0, maxDrawdown: 0 }));

  await page.locator(".hz-tab", { hasText: "SCORES" }).click();
  const rows = page.getByTestId("score-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Atlas Reyner");
  await expect(rows.nth(0)).toContainText("63% of 8");
  await expect(rows.nth(0)).toContainText("+$212");
  await expect(rows.nth(1)).toContainText("GUEST · MCP");
  await expect(page.getByRole("link", { name: "EXPORT IDEAS" })).toHaveAttribute("href", /\/export\/ideas\.jsonl$/);

  await page.locator(".hz-agent", { hasText: "Atlas Reyner" }).click();
  const drawer = page.getByRole("dialog", { name: /Atlas Reyner settings/ });
  await expect(drawer).toContainText("TRACK RECORD · PAPER");
  await expect(drawer).toContainText("5 of 8 ideas");
  await expect(drawer).toContainText("-$48");
});

test("without core the SCORES tab explains where the numbers come from", async ({ page }) => {
  await openDesk(page);
  await page.locator(".hz-tab", { hasText: "SCORES" }).click();
  await expect(page.locator(".hz-centre")).toContainText("Scorecards come from Bourse Core");
  await expect(page.getByTestId("score-row")).toHaveCount(0);
});

test("RESET PAPER needs two clicks and asks core to reset", async ({ page }) => {
  const core = await mockCore(page);
  let resets = 0;
  await page.route(/127\.0\.0\.1:4000\/paper\/reset/, (route) => {
    if (route.request().method() === "POST") resets++;
    return route.fulfill({ json: { ok: true } });
  });
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  core.send({
    type: "scorecard", agentId: "TKT-002", role: "Execution Trader", name: "Atlas Reyner", model: "m", ideas: 1, holds: 0, scored: 0, hits: 0, hitRate: null,
    avgReturnPct: null, fills: 1, vetoes: 0, notional: 1, closes: 0, wins: 0, winRate: null, realized: 0, pnl: 5, peakPnl: 5, maxDrawdown: 0, updatedAt: 1, ts: 1,
  });
  await page.locator(".hz-tab", { hasText: "SCORES" }).click();
  const btn = page.getByRole("button", { name: "RESET PAPER" });
  await btn.click();
  await expect(page.getByRole("button", { name: "CLICK AGAIN TO RESET" })).toBeVisible();
  expect(resets).toBe(0);
  await page.getByRole("button", { name: "CLICK AGAIN TO RESET" }).click();
  await expect.poll(() => resets).toBe(1);
  await page.locator(".hz-tab", { hasText: "FLOOR CHAT" }).click();
  await expect(page.locator(".hz-log")).toContainText("Paper books and scorecards reset by YOU");
});
