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
