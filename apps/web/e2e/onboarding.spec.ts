import { expect, openDesk, test } from "./fixtures";

test.use({ firstRun: true });
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

const next = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "CONTINUE" }).click();

test("opens on first run and walks through all six steps", async ({ page, errors }) => {
  await openDesk(page);
  const onb = page.locator(".hz-onb");
  await expect(onb).toBeVisible();
  await expect(onb).toContainText("STEP 01 OF 06");
  await expect(onb.locator(".hz-onb-card")).toHaveCount(6);

  await next(page);
  await expect(onb).toContainText("STEP 02 OF 06");
  await expect(onb.locator(".hz-onb-card")).toHaveCount(6);
  await expect(onb.locator(".hz-onb-note")).toContainText("isn't connected to anything yet");

  await next(page);
  await expect(onb).toContainText("STEP 03 OF 06");
  await expect(onb.locator(".hz-onb-card")).toHaveCount(9);

  await next(page);
  await expect(onb).toContainText("STEP 04 OF 06");
  await expect(onb.locator(".hz-onb-card")).toHaveCount(8);

  await next(page);
  await expect(onb).toContainText("STEP 05 OF 06");
  await expect(onb.locator("[role=checkbox]")).toHaveCount(8);
  await expect(onb.locator(".hz-onb-auto")).toHaveCount(3);

  await next(page);
  await expect(onb).toContainText("STEP 06 OF 06");
  await expect(onb).toContainText("Not available yet");
  await expect(onb.getByRole("button", { name: /LAUNCH LIVE|LIVE NEEDS/ })).toHaveCount(0);

  await onb.getByRole("button", { name: "LAUNCH DEMO DESK" }).click();
  await expect(onb).toHaveCount(0);
  await expect(page.locator(".hz-agent")).toHaveCount(8);
  expect(errors).toEqual([]);
});

test("runtime is a single choice and shows its credential field", async ({ page }) => {
  await openDesk(page);
  const claude = page.locator(".hz-onb-card", { hasText: "Claude" }).first();
  await claude.click();
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await expect(claude.locator("input[type=password]")).toBeVisible();
  await page.locator(".hz-onb-card", { hasText: "OpenAI" }).first().click();
  await expect(claude).toHaveAttribute("aria-checked", "false");
});

test("venues are coming-soon placeholders: no selection, no key fields", async ({ page }) => {
  await openDesk(page);
  await page.locator(".hz-onb-rail-item", { hasText: "Venues" }).click();
  const venues = page.locator(".hz-onb-card");
  await expect(venues).toHaveCount(8);
  await expect(page.locator(".hz-onb-card[data-soon]")).toHaveCount(7);
  await page.locator(".hz-onb-card", { hasText: "Binance" }).click({ force: true });
  await expect(page.locator(".hz-onb input")).toHaveCount(0);
  await expect(page.locator(".hz-onb-card", { hasText: "Paper venue" })).toHaveAttribute("aria-checked", "true");
});

test("secrets typed in setup are never written to localStorage", async ({ page }) => {
  await openDesk(page);
  await page.locator(".hz-onb-card", { hasText: "Claude" }).first().click();
  await page.locator(".hz-onb-card[aria-checked=true] input").fill("sk-ant-TOPSECRET123");
  await page.locator(".hz-onb-rail-item", { hasText: "Floor & risk" }).click();
  await page.locator(".hz-onb-auto", { hasText: "AUTO" }).click();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("TOPSECRET");
  expect(stored).toContain("AUTO"); // non-secret choices are saved
});

test("skip marks setup done and it stays closed after a reload; SETUP reopens it", async ({ page }) => {
  await openDesk(page);
  await page.getByRole("button", { name: /SKIP/ }).click();
  await expect(page.locator(".hz-onb")).toHaveCount(0);
  await page.reload();
  await page.locator(".hz-header").waitFor();
  await expect(page.locator(".hz-onb")).toHaveCount(0);
  await page.getByRole("button", { name: "SETUP" }).click();
  await expect(page.locator(".hz-onb")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".hz-onb")).toHaveCount(0);
});

test("reset needs a second click", async ({ page }) => {
  await openDesk(page);
  await page.locator(".hz-onb-rail-item", { hasText: "Floor & risk" }).click();
  await page.locator(".hz-onb-auto", { hasText: "AUTO" }).click();
  await expect(page.locator(".hz-onb-auto", { hasText: "AUTO" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "RESET TO DEFAULTS" }).click();
  await expect(page.getByRole("button", { name: "CONFIRM RESET" })).toBeVisible();
  await page.getByRole("button", { name: "CONFIRM RESET" }).click();
  await page.locator(".hz-onb-rail-item", { hasText: "Floor & risk" }).click();
  await expect(page.locator(".hz-onb-auto", { hasText: "APPROVE" })).toHaveAttribute("aria-checked", "true");
});

test("on mobile the step rail is hidden and nothing overflows sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openDesk(page);
  await expect(page.locator(".hz-onb-rail")).toHaveCount(0);
  await expect(page.locator(".hz-onb")).toContainText("STEP 01 OF 06");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("saving keys to core", () => {
  const CORE = "http://127.0.0.1:4000";
  const KEY_ID = "runtime.claude.key";

  test("a key goes to core, leaves the page, and is never stored in the browser", async ({ page }) => {
    const stored = new Set<string>();
    const puts: Array<{ url: string; body: string }> = [];
    await page.route(`${CORE}/secrets**`, async (route) => {
      const req = route.request();
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,DELETE", "access-control-allow-headers": "content-type" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (req.method() === "PUT") {
        puts.push({ url: req.url(), body: req.postData() ?? "" });
        stored.add(decodeURIComponent(req.url().split("/secrets/")[1]!));
        return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
      }
      if (req.method() === "DELETE") {
        stored.delete(decodeURIComponent(req.url().split("/secrets/")[1]!));
        return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
      }
      return route.fulfill({ status: 200, headers: cors, json: { enabled: true, secrets: [...stored].map((id) => ({ id, updatedAt: 1 })) } });
    });

    await openDesk(page);
    await page.locator(".hz-onb-card", { hasText: "Claude" }).first().click();
    const row = page.getByTestId(`secret-${KEY_ID}`);
    await expect(row.getByRole("button", { name: "SAVE TO CORE" })).toBeDisabled(); // nothing typed yet
    await page.locator(".hz-onb-card[aria-checked=true] input").fill("sk-ant-TOPSECRET123");
    await row.getByRole("button", { name: "SAVE TO CORE" }).click();

    await expect(row).toContainText("SAVED IN CORE");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain(`/secrets/${KEY_ID}`);
    expect(JSON.parse(puts[0]!.body)).toEqual({ value: "sk-ant-TOPSECRET123" });
    await expect(page.locator(".hz-onb-card[aria-checked=true] input")).toHaveValue(""); // cleared from the page
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("TOPSECRET");

    await row.getByRole("button", { name: "REMOVE" }).click();
    await expect(row.getByRole("button", { name: "SAVE TO CORE" })).toBeVisible();
    expect(stored.size).toBe(0);
  });

  test("with core down, the field says the key stays in this tab only", async ({ page }) => {
    await openDesk(page);
    await page.locator(".hz-onb-card", { hasText: "Claude" }).first().click();
    await expect(page.getByTestId(`secret-${KEY_ID}`)).toContainText("Core isn't running");
    await expect(page.getByRole("button", { name: "SAVE TO CORE" })).toHaveCount(0);
  });

  test("with the store disabled, it explains how to turn it on", async ({ page }) => {
    await page.route(`${CORE}/secrets`, (route) =>
      route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, json: { enabled: false, secrets: [] } }),
    );
    await openDesk(page);
    await page.locator(".hz-onb-card", { hasText: "Claude" }).first().click();
    await expect(page.getByTestId(`secret-${KEY_ID}`)).toContainText("BOURSE_MASTER_KEY");
  });
});
