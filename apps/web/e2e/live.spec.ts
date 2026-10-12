import { expect, openDesk, test } from "./fixtures";

// Bourse has no execution layer. These tests pin down that no route reaches a "live" state.

test("the LIVE button explains that live trading is not available", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesk(page);
  await page.locator(".hz-header button", { hasText: /^LIVE$/ }).click();
  const modal = page.getByRole("dialog", { name: "Live trading" });
  await expect(modal).toContainText("Live trading isn't available yet");
  await expect(modal).toContainText("Nothing in this version can place a real order");
  await expect(modal.getByRole("button", { name: "GO LIVE" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.locator(".hz-livebanner")).toHaveCount(0);
  await expect(page.locator(".hz-header button", { hasText: "DEMO" }).first()).toHaveAttribute("data-on", "true");
});

test("a saved setup with venue keys filled in still cannot go live", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "hermes.setup.v1",
        JSON.stringify({
          done: true,
          on: { "venue.binance": true, "venue.hyperliquid": true, "venue.paper": true },
          vals: { "venue.binance.key": "k", "venue.hyperliquid.addr": "0xabc" },
        }),
      );
    } catch {
      /* ignore */
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesk(page);
  await page.locator(".hz-header button", { hasText: /^LIVE$/ }).click();
  await expect(page.getByRole("dialog", { name: "Live trading" })).toContainText("isn't available yet");
  await expect(page.locator(".hz-livebanner")).toHaveCount(0);
});

test("on mobile, the DEMO pill opens the notice instead of switching mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openDesk(page);
  await page.locator(".hz-modepill").click();
  await expect(page.getByRole("dialog", { name: "Live trading" })).toContainText("isn't available yet");
  await expect(page.locator(".hz-modepill")).toHaveText("DEMO");
});
