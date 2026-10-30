import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("with core, the news panel shows core's headlines with source and link; a bad link is just text", async ({ page, errors }) => {
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    const t = Date.now();
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: "lifecycle", agentId: "*", role: "floor", status: "running", ts: t });
    send({ type: "news", id: "n1", source: "CoinDesk", title: "Bitcoin ETF inflows hit $1.2B as BTC tops $96K", url: "https://www.coindesk.com/markets/a", publishedAt: t - 14 * 60_000, tag: "FLOW", symbols: ["BTC-USDT"], ts: t });
    send({ type: "news", id: "n2", source: "Feed", title: "<img src=x onerror=alert(1)> Fed holds rates", url: "javascript:alert(1)", publishedAt: t - 2 * 60_000, tag: "MACRO", symbols: [], ts: t });
  });
  await openDesk(page);
  await expect(page.getByTestId("news-label")).toHaveText("LIVE HEADLINES · UNVERIFIED");
  const rows = page.getByTestId("news-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("<img src=x onerror=alert(1)> Fed holds rates"); // rendered as text, never as markup
  await expect(rows.nth(0).locator("a")).toHaveCount(0);
  await expect(rows.nth(0).locator("img")).toHaveCount(0);
  const link = rows.nth(1).getByRole("link", { name: /Bitcoin ETF inflows/ });
  await expect(link).toHaveAttribute("href", "https://www.coindesk.com/markets/a");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(rows.nth(1)).toContainText("14m");
  await expect(rows.nth(1)).toContainText("CoinDesk · names BTC");
  expect(errors).toEqual([]);
});

test("without core the panel keeps its labelled sample headlines", async ({ page }) => {
  await openDesk(page);
  await expect(page.getByTestId("news-label")).toHaveText("SAMPLE HEADLINES");
  await expect(page.getByTestId("news-row").first()).toContainText("flagged · impact");
});
