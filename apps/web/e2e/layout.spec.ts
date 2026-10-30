import { expect, openDesk, test } from "./fixtures";

for (const width of [1280, 1440]) {
  test(`blotter at ${width}px: instrument names are whole and the STATUS column is inside the window`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openDesk(page);
    await page.locator(".hz-tab", { hasText: "BLOTTER" }).click();
    const row = page.locator(".hz-blotter-body").first();
    await expect(row).toBeVisible();
    const cells = row.locator(":scope > div:visible");
    const instrument = cells.nth(width >= 1440 ? 2 : 1);
    await expect(instrument).toHaveText(/^[A-Z]+-PERP$/);
    expect(await instrument.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const centre = (await page.locator(".hz-centre").boundingBox())!;
    const status = (await cells.last().boundingBox())!;
    expect(status.x + status.width).toBeLessThanOrEqual(centre.x + centre.width);
  });
}

test("mobile: chat lines say who wrote them, and the markets tab has the news", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openDesk(page);
  await page.locator(".hz-mnav button", { hasText: "CHAT" }).click();
  await expect(page.getByText("DEALING DIRECTOR", { exact: true }).first()).toBeVisible();
  await page.locator(".hz-mnav button", { hasText: "MARKETS" }).click();
  await expect(page.getByTestId("m-news-row").first()).toContainText("flagged");
});

test("mobile: the markets tab shows the model league when core is running", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.route(/127\.0\.0\.1:4000\/league/, (r) => r.fulfill({ json: { scored: 30, source: "log+session", rows: [
    { model: "openrouter-free:deepseek/deepseek-chat:free", ideas: 30, hits: 18, hitRate: 0.6, avgReturnPct: 0.08, seats: ["Quant / Signals"], firstAt: 1, lastAt: 2 },
  ] } }));
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => ws.send(JSON.stringify({ type: "lifecycle", agentId: "*", role: "floor", status: "running", ts: Date.now() })));
  await openDesk(page);
  await page.locator(".hz-mnav button", { hasText: "MARKETS" }).click();
  await expect(page.getByTestId("m-league-row")).toHaveCount(1);
  await expect(page.getByTestId("m-league-row")).toContainText("1. deepseek/deepseek-chat:free");
  await expect(page.getByTestId("m-league-row")).toContainText("+0.080%");
});
