import { test as base, expect, type Page } from "@playwright/test";

/**
 * Every test runs hermetically: requests to anything but the app itself are aborted, so the desk always falls back to
 * its simulated feed and results never depend on Binance, Coinbase or TradingView being reachable.
 * Setup is marked done unless a test opts into the first-run experience.
 */
export const test = base.extend<{ firstRun: boolean; errors: string[] }>({
  firstRun: [false, { option: true }],
  errors: async ({ page }, run) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await run(errors);
  },
  page: async ({ page, firstRun, baseURL }, run) => {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(baseURL ?? "http://localhost") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      return route.abort();
    });
    // Core is never reachable by default, even if a developer has one running locally: tests that want it mock it.
    await page.routeWebSocket(/127\.0\.0\.1:4000|localhost:4000/, (ws) => void ws.close());
    if (!firstRun) {
      await page.addInitScript(() => {
        try {
          if (!localStorage.getItem("hermes.setup.v1")) localStorage.setItem("hermes.setup.v1", JSON.stringify({ done: true }));
        } catch {
          /* sandboxed frame */
        }
      });
    }
    await run(page);
  },
});

export { expect };

export async function openDesk(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".hz-header, .hz-mtop").first().waitFor();
}
