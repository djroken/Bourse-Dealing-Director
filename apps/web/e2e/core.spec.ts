import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** Stands in for Hermes Core's /agents stream. */
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
  await expect(page.locator(".hz-log")).toContainText("Connected to Hermes Core");
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
  await expect(page.locator(".hz-log")).toContainText("Lost connection to Hermes Core");
});

test("with no core running the desk is the simulated floor and says so", async ({ page }) => {
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("SIMULATED FLOOR");
  await expect(page.locator(".hz-log")).not.toContainText("Hermes Core");
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
