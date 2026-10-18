import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openDesk(page);
});

test("bottom nav moves between the five tabs", async ({ page, errors }) => {
  await expect(page.locator(".hz-mrow").first()).toBeVisible();
  await page.locator(".hz-mnav-btn", { hasText: "CHAT" }).click();
  await expect(page.locator(".hz-mcomposer input")).toBeVisible();
  await page.locator(".hz-mnav-btn", { hasText: "QUEUE" }).click();
  await expect(page.locator(".hz-appr").first()).toBeVisible();
  await page.locator(".hz-mnav-btn", { hasText: "MARKETS" }).click();
  await expect(page.getByText("NET POS")).toBeVisible();
  await page.locator(".hz-mnav-btn", { hasText: "MORE" }).click();
  await expect(page.getByText("HALT ALL")).toBeVisible();
  expect(errors).toEqual([]);
});

test("opening an agent shows the drawer full-screen", async ({ page }) => {
  await page.locator(".hz-mrow").first().click();
  await expect(page.locator(".hz-drawer")).toBeVisible();
  const box = await page.locator(".hz-drawer").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(380);
});

test("the page does not scroll sideways", async ({ page }) => {
  for (const tab of ["FLOOR", "CHAT", "QUEUE", "MARKETS", "MORE"]) {
    await page.locator(".hz-mnav-btn", { hasText: tab }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
});

test("the markets tab shows agent scorecards, or explains where they come from", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    ws.send(JSON.stringify({ type: "lifecycle", agentId: "TKT-002", role: "Execution Trader", status: "running", ts: Date.now() }));
    ws.send(JSON.stringify({
      type: "scorecard", agentId: "TKT-002", role: "Execution Trader", name: "Atlas Reyner", model: "m", ideas: 9, holds: 0, scored: 8, hits: 5, hitRate: 0.625,
      avgReturnPct: 0.1, fills: 3, vetoes: 0, notional: 1, closes: 2, wins: 1, winRate: 0.5, realized: 0, pnl: 42, peakPnl: 50, maxDrawdown: 8, updatedAt: 1, ts: 1,
    }));
  });
  await page.reload(); // beforeEach opened the desk before this test's core existed
  await openDesk(page);
  await page.getByRole("button", { name: /MARKETS/ }).click();
  const card = page.getByTestId("mobile-score");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Atlas Reyner");
  await expect(card).toContainText("63% of 8");
  await expect(card).toContainText("+$42");
});
