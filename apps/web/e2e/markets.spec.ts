import type { Page } from "@playwright/test";
import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function coreWithStocks(page: Page, open: boolean) {
  await page.route(/127\.0\.0\.1:4000\/instruments/, (r) => r.fulfill({ json: {
    instruments: [
      { symbol: "BTC-USDT", kind: "crypto", label: "BTC/USDT", dp: 0, tv: "BINANCE:BTCUSDT" },
      { symbol: "AAPL", kind: "stock", label: "AAPL", dp: 2, tv: "AAPL" },
      { symbol: "NVDA", kind: "stock", label: "NVDA", dp: 2, tv: "NVDA" },
    ],
    stocks: { enabled: true, keySet: true, needsRestart: false, market: { open, nextOpen: open ? null : "2026-10-26T09:30:00-04:00", nextClose: null, from: "alpaca" } },
  } }));
  let candleAsks = 0;
  await page.route(/127\.0\.0\.1:4000\/candles/, (r) => {
    candleAsks++;
    const now = Date.now();
    return r.fulfill({ json: { symbol: "AAPL", tf: "5m", candles: Array.from({ length: 60 }, (_, i) => ({ t: now - (60 - i) * 300_000, o: 230 + i * 0.1, h: 231 + i * 0.1, l: 229 + i * 0.1, c: 230.5 + i * 0.1 })) } });
  });
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => ws.send(JSON.stringify({ type: "lifecycle", agentId: "*", role: "floor", status: "running", ts: 1 })));
  await page.routeWebSocket(/127\.0\.0\.1:4000\/$/, (ws) => {
    const send = () => {
      ws.send(JSON.stringify({ type: "price", symbol: "AAPL", price: 231.42, change24h: 0.85, source: "alpaca", ts: Date.now(), marketOpen: open }));
      ws.send(JSON.stringify({ type: "price", symbol: "NVDA", price: 141.07, change24h: -1.2, source: "alpaca", ts: Date.now(), marketOpen: open }));
    };
    send();
    setInterval(send, 1000);
  });
  return { candleAsks: () => candleAsks };
}

test("stocks from core appear on the tape with prices from core's feed, and say when the market is closed", async ({ page, errors }) => {
  await coreWithStocks(page, false);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const aapl = page.locator(".hz-tape-cell", { hasText: "AAPL" });
  await expect(aapl).toContainText("231.42");
  await expect(aapl).toContainText("CLOSED");
  expect(errors).toEqual([]);
});

test("clicking a stock charts it from core's candles, with the market state and no funding", async ({ page }) => {
  const core = await coreWithStocks(page, true);
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  const aapl = page.locator(".hz-tape-cell", { hasText: "AAPL" });
  await expect(aapl).toContainText("+0.85%");
  await aapl.click();
  const rail = page.locator(".hz-rail");
  await rail.getByRole("button", { name: "NATIVE" }).click();
  await expect(rail).toContainText("AAPL");
  await expect(rail).toContainText("ALPACA");
  await expect(rail).toContainText("US MARKET OPEN");
  await expect.poll(() => core.candleAsks()).toBeGreaterThan(0);
  await expect(rail).not.toContainText("SIMULATED CANDLES");
  await expect(rail.locator(".hz-native rect").first()).toBeVisible();
  await expect(rail.locator(".hz-chartstats")).toContainText("—"); // no funding for a stock

  await page.locator(".hz-tab", { hasText: "REPLAY" }).click();
  await expect(page.getByRole("group", { name: "Replay symbol" }).getByRole("button", { name: "NVDA" })).toBeVisible();
});

test("the tape works from the keyboard", async ({ page }) => {
  await openDesk(page);
  const eth = page.locator(".hz-tape-cell", { hasText: "ETH/USDT" });
  await eth.focus();
  await page.keyboard.press("Enter");
  await expect(eth).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".hz-rail")).toContainText("ETH/USDT");
});
