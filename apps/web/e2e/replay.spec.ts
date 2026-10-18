import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

const seat = (role: string, name: string, model: string, over: Record<string, unknown> = {}) => ({
  role, name, model, evaluated: 2000, ideas: 900, holds: 1100, failed: 0, hits: 470, hitRate: 0.522, avgReturnPct: 0.0123, pnl: 318.6, fees: 41.2,
  wins: 440, winRate: 0.489, maxDrawdown: 210.4, bestPct: 1.4, worstPct: -1.1, ...over,
});

test("replay: pick settings, run, watch progress, read results, export", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  let polls = 0;
  const base = { id: "R9", seats: ["Execution Trader", "Quant / Signals"], startedAt: Date.now(), error: null };
  await page.route(/127\.0\.0\.1:4000\/replay/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posted = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 202, json: { ...base, status: "fetching", progress: 0, params: { ...posted, feeBps: 5, maxModelCalls: 60 }, finishedAt: null, result: null } });
    }
    if (req.url().endsWith("/replay")) return route.fulfill({ json: { job: null } });
    polls++;
    const params = { symbol: "ETH-USDT", timeframe: "1h", days: 14, horizon: 3, feeBps: 5, maxModelCalls: 60 };
    if (polls < 2) return route.fulfill({ json: { ...base, status: "running", progress: 0.5, params, finishedAt: null, result: null } });
    return route.fulfill({ json: { ...base, status: "done", progress: 1, params, finishedAt: Date.now(), result: {
      from: Date.UTC(2026, 9, 4), to: Date.UTC(2026, 9, 18), candles: 336, source: "binance", marketReturnPct: -2.4,
      seats: [seat("Execution Trader", "Atlas Reyner", "stub"), seat("Quant / Signals", "Pico Nandra", "ollama:llama3.2", { failed: 3, pnl: -55.2, hitRate: 0.41 })],
    } } });
  });
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    ws.send(JSON.stringify({ type: "lifecycle", agentId: "TKT-002", role: "Execution Trader", status: "running", ts: Date.now() }));
  });
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.locator(".hz-tab", { hasText: "REPLAY" }).click();

  await page.getByRole("group", { name: "Replay symbol" }).getByRole("button", { name: "ETH/USDT" }).click();
  await page.getByRole("group", { name: "Replay timeframe" }).getByRole("button", { name: "1H" }).click();
  await page.getByRole("group", { name: "Replay period" }).getByRole("button", { name: "14D" }).click();
  await page.locator(".hz-centre").getByRole("button", { name: /Kite Alvarez/ }).click(); // drop Market Maker
  await page.locator(".hz-centre").getByRole("button", { name: /Corva Lin/ }).click(); // drop Sentiment Desk
  await page.getByRole("button", { name: "RUN REPLAY" }).click();

  await expect.poll(() => posted).toMatchObject({ symbol: "ETH-USDT", timeframe: "1h", days: 14, horizon: 3, roles: ["Execution Trader", "Quant / Signals"] });
  await expect(page.getByTestId("replay-status")).toContainText("REPLAY FINISHED", { timeout: 8000 });
  const rows = page.getByTestId("replay-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Atlas Reyner");
  await expect(rows.nth(0)).toContainText("+$319");
  await expect(rows.nth(1)).toContainText("-$55");
  await expect(page.locator(".hz-centre")).toContainText("holding ETH returned -2.40%");
  await expect(page.getByRole("link", { name: "EXPORT IDEAS" })).toHaveAttribute("href", /\/replay\/R9\/ideas\.jsonl$/);
});

test("replay explains itself without core", async ({ page }) => {
  await openDesk(page);
  await page.locator(".hz-tab", { hasText: "REPLAY" }).click();
  await expect(page.locator(".hz-centre")).toContainText("Replay runs inside Bourse Core");
});

test("a refused replay shows the reason", async ({ page }) => {
  await page.route(/127\.0\.0\.1:4000\/replay/, (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 409, json: { error: "a replay is already running" } }) : route.fulfill({ json: { job: null } }),
  );
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => ws.send(JSON.stringify({ type: "lifecycle", agentId: "*", role: "floor", status: "running", ts: 1 })));
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");
  await page.locator(".hz-tab", { hasText: "REPLAY" }).click();
  await page.getByRole("button", { name: "RUN REPLAY" }).click();
  await expect(page.locator(".hz-centre").getByRole("alert")).toContainText("a replay is already running");
});
