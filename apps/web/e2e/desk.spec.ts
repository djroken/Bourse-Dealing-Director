import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesk(page);
});

test("renders the roster and labels the floor as simulated", async ({ page, errors }) => {
  await expect(page.locator(".hz-agent")).toHaveCount(8);
  await expect(page.getByText("SIMULATED FLOOR", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("SAMPLE HEADLINES")).toBeVisible();
  await expect(page.locator(".hz-footer")).toContainText("PAPER ONLY");
  await expect(page.locator(".hz-footer")).not.toContainText("ENGINE LIVE");
  expect(errors).toEqual([]);
});

test("roster filter narrows and restores", async ({ page }) => {
  await page.locator(".hz-chip", { hasText: "RISK" }).click();
  await expect(page.locator(".hz-agent")).toHaveCount(1);
  await page.locator(".hz-chip", { hasText: "ALL" }).click();
  await expect(page.locator(".hz-agent")).toHaveCount(8);
});

test("clicking the tape selects the chart symbol", async ({ page }) => {
  const before = await page.locator(".hz-rail .hz-panel-head").first().innerText();
  await page.locator(".hz-tape-cell").nth(1).click();
  await expect(page.locator(".hz-rail .hz-panel-head").first()).not.toHaveText(before);
});

test("sending an instruction gets an acknowledgement", async ({ page }) => {
  await page.locator(".hz-composer input").fill("flatten the SOL book");
  await page.keyboard.press("Enter");
  await expect(page.getByText("flatten the SOL book")).toBeVisible();
  await expect(page.getByText("Acknowledged.").first()).toBeVisible();
  await expect(page.locator(".hz-composer input")).toHaveValue("");
});

test("approvals: resize, reject, approve, then the queue is clear", async ({ page }) => {
  await page.locator(".hz-tab", { hasText: "APPROVALS" }).click();
  const cards = page.locator(".hz-appr");
  const start = await cards.count();
  expect(start).toBeGreaterThan(0);

  await cards.first().locator("button.hz-size", { hasText: "2×" }).click();
  await expect(cards.first().locator("button.hz-size", { hasText: "2×" })).toHaveAttribute("data-on", "true");

  await cards.first().getByRole("button", { name: "REJECT" }).click();
  await expect(cards).toHaveCount(start - 1);

  while ((await cards.count()) > 0) await cards.first().locator("button.hz-btn--solid").click();
  await expect(page.getByText("QUEUE CLEAR")).toBeVisible();

  await page.locator(".hz-tab", { hasText: "BLOTTER" }).click();
  await expect(page.locator(".hz-blotter-row").first()).toBeVisible();
});

test("closing the floor window keeps the conversation", async ({ page }) => {
  await page.locator(".hz-composer input").fill("remember me");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "FLOOR OPEN" }).click();
  await expect(page.getByText("remember me")).toHaveCount(0);
  await page.getByRole("button", { name: "OPEN FLOOR" }).click();
  await expect(page.getByText("remember me")).toBeVisible();
});

test("agent drawer: open, pause, close with Escape", async ({ page }) => {
  await page.locator(".hz-agent").first().click();
  const drawer = page.locator(".hz-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: /^PAUSE/ }).click();
  await expect(drawer.getByRole("button", { name: /^RESUME/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("HALT ALL stops new floor events and RESUME restarts them", async ({ page }) => {
  await page.getByRole("button", { name: "HALT ALL" }).click();
  await expect(page.getByRole("button", { name: "RESUME" })).toBeVisible();
  await expect(page.locator(".hz-footer")).toContainText("HALTED");
  await page.getByRole("button", { name: "RESUME" }).click();
  await expect(page.locator(".hz-footer")).toContainText("SIMULATED FLOOR");
});

test("theme choice persists across a reload", async ({ page }) => {
  await page.locator(".hz-footer button", { hasText: "LIGHT" }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c161A20").trim())).toBe("#FFFFFF");
  await page.reload();
  await page.locator(".hz-header").waitFor();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c161A20").trim())).toBe("#FFFFFF");
});
