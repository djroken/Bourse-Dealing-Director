import { CORE_URL } from "./secrets";

/**
 * Core's broker paper accounts (GET /venues): Alpaca paper for stocks, the Binance testnet for crypto. Both are sandboxes
 * with play money; core can't reach a live account. Untrusted input, checked field by field.
 */

export type BrokerId = "alpaca-paper" | "binance-testnet";
export const BROKER_IDS: readonly BrokerId[] = ["alpaca-paper", "binance-testnet"];
export interface BrokerStatus {
  id: BrokerId;
  label: string;
  markets: "stocks" | "crypto";
  enabled: boolean;
  keySet: boolean;
  routing: boolean;
}
export const BROKER_LABEL: Record<BrokerId, string> = { "alpaca-paper": "Alpaca paper", "binance-testnet": "Binance testnet" };

type Fetch = typeof fetch;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBroker = (v: unknown): v is BrokerId => typeof v === "string" && (BROKER_IDS as readonly string[]).includes(v);

export function parseVenues(raw: unknown): BrokerStatus[] | null {
  if (!isObj(raw) || !Array.isArray(raw.venues)) return null;
  const out: BrokerStatus[] = [];
  for (const v of raw.venues) {
    if (!isObj(v) || !isBroker(v.id) || v.sandbox !== true) continue; // only ever show sandboxes as sandboxes
    if (typeof v.enabled !== "boolean" || typeof v.keySet !== "boolean" || typeof v.routing !== "boolean") continue;
    out.push({ id: v.id, label: BROKER_LABEL[v.id], markets: v.id === "alpaca-paper" ? "stocks" : "crypto", enabled: v.enabled, keySet: v.keySet, routing: v.routing });
  }
  return out;
}

export async function fetchVenues(f: Fetch = fetch, base: string = CORE_URL): Promise<BrokerStatus[] | null> {
  try {
    const r = await f(`${base}/venues`);
    return r.ok ? parseVenues(await r.json()) : null;
  } catch {
    return null;
  }
}

export async function setVenue(id: BrokerId, enabled: boolean, f: Fetch = fetch, base: string = CORE_URL): Promise<BrokerStatus[] | null> {
  try {
    const r = await f(`${base}/venues/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    return r.ok ? parseVenues(await r.json()) : null;
  } catch {
    return null;
  }
}

/** A one-line result for the CHECK button: "OK · testnet account, 10,000 USDT free" or the broker's reason. */
export async function checkVenue(id: BrokerId, f: Fetch = fetch, base: string = CORE_URL): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await f(`${base}/venues/${id}/check`, { method: "POST" });
    const j: unknown = await r.json().catch(() => null);
    if (!r.ok || !isObj(j)) return { ok: false, text: `core answered ${r.status}` };
    const clip = (v: unknown) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, 160) : "");
    return j.ok === true ? { ok: true, text: `OK · ${clip(j.detail) || "key works"}` } : { ok: false, text: clip(j.reason) || "check failed" };
  } catch {
    return { ok: false, text: "Can't reach core" };
  }
}

/** The status line under a broker card. */
export function brokerLine(st: BrokerStatus | undefined, coreUp: boolean): string {
  if (!coreUp) return "Core isn't running. Start it with pnpm dev, then approved orders can go to this sandbox.";
  if (!st) return "This version of core has no broker paper accounts.";
  const what = st.markets === "stocks" ? "US stock" : "crypto";
  if (st.routing) return `ROUTING ON · ${what} orders you approve go to ${st.label} and book its fill. Play money.`;
  if (st.enabled) return `Routing is on but no key is saved, so ${what} orders still fill on core's paper venue.`;
  return `Off · ${what} orders you approve fill on core's paper venue at the live price.`;
}
