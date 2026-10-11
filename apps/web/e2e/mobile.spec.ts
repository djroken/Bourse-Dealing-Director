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
