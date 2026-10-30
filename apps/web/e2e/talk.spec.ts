import { expect, openDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("the floor conversation: the owner's instruction goes to core, the agents' replies show with who wrote them", async ({ page, errors }) => {
  const sent: Array<Record<string, unknown>> = [];
  await page.routeWebSocket(/127\.0\.0\.1:4000\/agents/, (ws) => {
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: "lifecycle", agentId: "*", role: "floor", status: "running", ts: Date.now() });
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      sent.push(m);
      if (m.type !== "instruct") return;
      const t = Date.now();
      const line = (agentId: string, role: string, name: string, text: string, extra: Record<string, unknown>) => send({ type: "chat", agentId, role, name, text, ts: t, round: "T1", ...extra });
      line("OWNER", "Owner", "YOU", m.text, {});
      line("TKT-001", "Dealing Director", "Vega Ostrowski", "SOL is leading the tape. Pico, is it real?", { model: "ollama:llama3.2" });
      line("TKT-004", "Quant / Signals", "Pico Nandra", "Momentum is clean, Vega. I'd buy a small clip.", { model: "ollama:llama3.2" });
      line("TKT-007", "Risk Officer", "Bastion Cole", "No open risk on the floor. Every desk is inside its limits.", { stub: true });
      send({ type: "intent", agentId: "TKT-004", role: "Quant / Signals", symbol: "SOL-USDT", side: "BUY", size: 2.5, confidence: 0.7, rationale: "ollama:llama3.2 in floor talk: Momentum is clean", needsApproval: true, ts: t });
      send({ type: "usage", agentId: "TKT-004", role: "Quant / Signals", callsToday: 3, tokensToday: 2_400, spendToday: 0, latencyMs: 920, ts: t });
    });
  });
  await openDesk(page);
  await expect(page.locator(".hz-sim")).toContainText("CORE FLOOR");

  await page.getByLabel("Instruct the floor").fill("Is SOL worth a punt before the US open?");
  await page.getByRole("button", { name: "SEND" }).click();
  await expect.poll(() => sent.find((m) => m.type === "instruct")).toMatchObject({ type: "instruct", text: "Is SOL worth a punt before the US open?" });

  const log = page.locator(".hz-log");
  await expect(log).toContainText("Is SOL worth a punt before the US open?");
  await expect(log).toContainText("SOL is leading the tape. Pico, is it real?");
  await expect(log).toContainText("Momentum is clean, Vega.");
  await expect(log).toContainText("STUB RULE");
  await expect(log.getByRole("separator", { name: /FLOOR ROUND · \d\d:\d\d UTC · 3 speakers/ })).toHaveCount(1);
  await expect(log).toContainText("ollama:llama3.2");
  await expect(log).not.toContainText("Acknowledged. Routing that"); // no scripted reply on a real floor

  await page.locator(".hz-tab", { hasText: "APPROVALS" }).click();
  await expect(page.locator(".hz-appr", { hasText: "SOL-PERP" })).toHaveCount(1);

  await page.locator(".hz-agent", { hasText: "Pico Nandra" }).click();
  const drawer = page.getByRole("dialog", { name: /Pico Nandra settings/ });
  await expect(drawer).toContainText("2.4k");
  await expect(drawer).toContainText("920ms");
  expect(errors).toEqual([]);
});

test("without core, the composer keeps the simulated floor's scripted reply", async ({ page }) => {
  await openDesk(page);
  await page.getByLabel("Instruct the floor").fill("hello");
  await page.getByRole("button", { name: "SEND" }).click();
  await expect(page.locator(".hz-log")).toContainText("Acknowledged.");
});
