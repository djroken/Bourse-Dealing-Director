import { expect, openDesk, test } from "./fixtures";

test.use({ firstRun: true });

/** Core's /venues, mocked: the owner switches on the Binance testnet and checks the key. */
test("setup shows core's broker paper accounts: route approved orders there and check the key", async ({ page, errors }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let enabled = false;
  const list = () => ({ venues: [
    { id: "alpaca-paper", label: "Alpaca paper", markets: "stocks", enabled: false, keySet: false, routing: false, sandbox: true },
    { id: "binance-testnet", label: "Binance testnet", markets: "crypto", enabled, keySet: true, routing: enabled, sandbox: true },
  ], live: false });
  const puts: string[] = [];
  await page.route(/127\.0\.0\.1:4000\/venues/, async (route) => {
    const req = route.request();
    if (req.url().endsWith("/check")) return route.fulfill({ json: { ok: true, detail: "testnet account, 10,000 USDT free" } });
    if (req.method() === "PUT") {
      puts.push(req.postData() ?? "");
      enabled = JSON.parse(req.postData() ?? "{}").enabled === true;
    }
    return route.fulfill({ json: list() });
  });
  await openDesk(page);
  const onb = page.locator(".hz-onb");
  await onb.locator(".hz-onb-rail-item", { hasText: "Venues" }).click();
  const card = onb.locator(".hz-onb-card", { hasText: "Binance spot testnet" });
  await expect(card).toContainText("FREE · PLAY MONEY");
  await card.click();
  const row = page.getByTestId("broker-binance-testnet");
  await expect(row).toContainText("Off · crypto orders you approve fill on core's paper venue");
  await row.getByRole("button", { name: "ROUTE APPROVED ORDERS HERE" }).click();
  await expect(row).toContainText("ROUTING ON · crypto orders you approve go to Binance testnet");
  expect(puts).toEqual(['{"enabled":true}']);
  await row.getByRole("button", { name: "CHECK KEY" }).click();
  await expect(row.getByRole("status")).toHaveText("OK · testnet account, 10,000 USDT free");
  // The card is still a sandbox: Live stays locked.
  await onb.locator(".hz-onb-rail-item", { hasText: "Review" }).click();
  await expect(onb).toContainText("Not available yet");
  expect(errors).toEqual([]);
});

test("without core the broker card says so and offers no switch", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesk(page);
  const onb = page.locator(".hz-onb");
  await onb.locator(".hz-onb-rail-item", { hasText: "Venues" }).click();
  await onb.locator(".hz-onb-card", { hasText: "Alpaca paper trading" }).click();
  const row = page.getByTestId("broker-alpaca-paper");
  await expect(row).toContainText("Core isn't running");
  await expect(row.getByRole("button")).toHaveCount(0);
});
