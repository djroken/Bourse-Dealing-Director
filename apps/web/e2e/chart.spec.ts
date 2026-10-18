import type { Page } from "@playwright/test";
import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

const rail = (page: Page) => page.locator(".hz-rail");

test("native candles, timeframe buttons and full screen with Esc", async ({ page, errors }) => {
  await openDesk(page);
  await rail(page).getByRole("button", { name: "NATIVE" }).click();
  await expect(rail(page).locator(".hz-native rect").first()).toBeVisible();
  await expect(rail(page)).toContainText("SIMULATED CANDLES"); // no exchange in tests: honest label

  await rail(page).getByRole("group", { name: "Timeframe" }).getByRole("button", { name: "1H" }).click();
  await expect(rail(page).getByRole("group", { name: "Timeframe" }).getByRole("button", { name: "1H" })).toHaveAttribute("aria-pressed", "true");
  await expect(rail(page).locator(".hz-panel-head").first()).toContainText("1h ·");

  await rail(page).getByRole("button", { name: "Full screen chart" }).click();
  const full = page.getByRole("dialog", { name: /chart, full screen/ });
  await expect(full).toBeVisible();
  await expect(rail(page)).toContainText("Chart is open full screen"); // one chart at a time
  await full.getByRole("group", { name: "Symbol" }).getByRole("button", { name: "ETH/USDT" }).click();
  await expect(full).toHaveAttribute("aria-label", /ETH\/USDT/);
  await expect(full).toContainText("Signals come from Bourse Core");
  await page.keyboard.press("Escape");
  await expect(full).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("agents' ideas from core are pre-loaded onto the chart as markers", async ({ page }) => {
  const now = Date.now();
  const idea = (id: string, side: "BUY" | "SELL", ago: number, correct: boolean | null) => ({
    id, ts: now - ago, agentId: "TKT-004", role: "Quant / Signals", name: "Pico Nandra", model: "ollama:llama3.2", temperature: 0.2,
    autonomy: "APPROVE", symbol: "BTC-USDT", side, size: 0.01, confidence: 0.7, rationale: `idea ${id}`, price: 96400, change24h: 1,
    source: "binance", filled: id === "a",
    outcome: correct === null ? null : { horizonMs: 900000, exitPrice: 96500, returnPct: correct ? 0.1 : -0.1, correct },
  });
  let asked = "";
  await page.route(/127\.0\.0\.1:4000\/ideas/, (route) => {
    asked = route.request().url();
    return route.fulfill({ json: [idea("a", "BUY", 3_600_000, true), idea("b", "SELL", 1_800_000, false), idea("c", "BUY", 60_000, null)] });
  });
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    ws.send(JSON.stringify({ type: "lifecycle", agentId: "TKT-004", role: "Quant / Signals", status: "running", ts: now }));
  });
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await rail(page).getByRole("button", { name: "NATIVE" }).click();
  await expect(rail(page).getByTestId("signal-marker")).toHaveCount(3);
  expect(asked).toContain("symbol=BTC-USDT");
  const buy = rail(page).locator('.hz-mk[data-state="hit"]');
  await buy.hover();
  await expect(buy.getByRole("tooltip")).toContainText("Pico Nandra · BUY");

  await rail(page).getByRole("button", { name: "SIGNALS" }).click();
  await expect(rail(page).getByTestId("signal-marker")).toHaveCount(0);
  await rail(page).getByRole("button", { name: "SIGNALS" }).click();

  await rail(page).getByRole("button", { name: "Full screen chart" }).click();
  const full = page.getByRole("dialog", { name: /chart, full screen/ });
  await expect(full.getByTestId("signal-row")).toHaveCount(3);
  await expect(full.getByTestId("signal-row").first()).toContainText("idea c");
  await expect(full.getByTestId("signal-row").first()).toContainText("open");
});

test("on a phone the markets tab has the tools and full screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDesk(page);
  await page.getByRole("button", { name: /MARKETS/ }).click();
  await page.getByRole("button", { name: "NATIVE" }).click();
  await page.getByRole("button", { name: "Full screen chart" }).click();
  const full = page.getByRole("dialog", { name: /chart, full screen/ });
  await expect(full).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await full.getByRole("button", { name: "Exit full screen" }).click();
  await expect(full).toHaveCount(0);
});
