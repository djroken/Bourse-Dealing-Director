import { describe, expect, it } from "vitest";
import { brokerLine, checkVenue, parseVenues, setVenue } from "../lib/desk/venues";

const row = (over: Record<string, unknown> = {}) => ({ id: "binance-testnet", label: "x", markets: "crypto", enabled: false, keySet: true, routing: false, sandbox: true, ...over });

describe("core's broker paper accounts", () => {
  it("keeps only known sandboxes with well-formed fields", () => {
    expect(parseVenues({ venues: [row(), row({ id: "binance" }), row({ id: "alpaca-paper", sandbox: false }), row({ id: "alpaca-paper", enabled: "yes" })] })).toEqual([
      { id: "binance-testnet", label: "Binance testnet", markets: "crypto", enabled: false, keySet: true, routing: false },
    ]);
    expect(parseVenues("nope")).toBeNull();
  });
  it("the status line says where approved orders go", () => {
    const [st] = parseVenues({ venues: [row()] })!;
    expect(brokerLine(st, true)).toMatch(/^Off · crypto orders you approve fill on core's paper venue/);
    expect(brokerLine({ ...st!, enabled: true, routing: true }, true)).toMatch(/^ROUTING ON · crypto orders you approve go to Binance testnet/);
    expect(brokerLine({ ...st!, enabled: true, keySet: false }, true)).toMatch(/no key is saved/);
    expect(brokerLine(undefined, false)).toMatch(/Core isn't running/);
  });
  it("talks to core and reports failures as text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/check")) return new Response(JSON.stringify({ ok: false, reason: "Invalid API-key, IP, or permissions for action." }), { status: 200 });
      return new Response(JSON.stringify({ venues: [row({ enabled: true, routing: true })] }), { status: 200 });
    }) as typeof fetch;
    expect((await setVenue("binance-testnet", true, f, "http://c"))![0]!.routing).toBe(true);
    expect(calls[0]).toMatchObject({ url: "http://c/venues/binance-testnet", init: { method: "PUT", body: '{"enabled":true}' } });
    expect(await checkVenue("binance-testnet", f, "http://c")).toEqual({ ok: false, text: "Invalid API-key, IP, or permissions for action." });
    expect(await checkVenue("binance-testnet", (async () => { throw new Error("down"); }) as typeof fetch, "http://c")).toEqual({ ok: false, text: "Can't reach core" });
  });
});
