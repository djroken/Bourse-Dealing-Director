import { createHmac, randomUUID } from 'node:crypto';

/**
 * Broker paper accounts: real exchange order handling with play money. Two venues, both sandboxes by construction:
 * - Alpaca paper trading (US stocks), https://paper-api.alpaca.markets
 * - Binance spot testnet (crypto), https://testnet.binance.vision
 * The base URLs are constants and cannot be configured, so nothing here can reach a live account; a test checks the file
 * for live hostnames. Everything a venue returns is untrusted and checked before core books a fill.
 */

export const ALPACA_PAPER = 'https://paper-api.alpaca.markets/v2';
export const BINANCE_TESTNET = 'https://testnet.binance.vision/api';

export type VenueId = 'alpaca-paper' | 'binance-testnet';
export const VENUE_LABEL: Record<VenueId, string> = { 'alpaca-paper': 'Alpaca paper', 'binance-testnet': 'Binance testnet' };

export interface Keys {
  key: string;
  secret: string;
}
/** fetch with the status kept, so a venue's error body can be reported. */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;

export interface VenueFill {
  qty: number;
  price: number;
  orderId: string;
}
export type VenueResult = { ok: true; fill: VenueFill; note?: string } | { ok: false; reason: string };
export interface VenueOrder {
  /** Core's symbol: "BTC-USDT" or "AAPL". */
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
}
export interface Venue {
  id: VenueId;
  label: string;
  /** Keys are present (read at call time, so saving them in Setup needs no restart). */
  ready(): boolean;
  submit(o: VenueOrder): Promise<VenueResult>;
  /** A cheap authenticated call, for the Setup "check" button. */
  check(): Promise<{ ok: true; detail: string } | { ok: false; reason: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const errText = (body: unknown, status: number): string => {
  const m = isObj(body) ? (body.msg ?? body.message) : undefined;
  return (typeof m === 'string' ? m.replace(/[^\x20-\x7e]/g, '').slice(0, 160) : '') || `HTTP ${status}`;
};
/** Format a quantity without exponent notation, at most 8 decimals, never rounding up. */
export const qtyStr = (q: number, dp = 8): string => {
  const f = 10 ** dp;
  return (Math.floor(q * f + 1e-9) / f).toFixed(dp).replace(/\.?0+$/, '');
};

// ---- Alpaca paper (US stocks) ------------------------------------------------------------------------------------

export function alpacaPaper(opts: { keys: () => Keys | undefined; http: HttpFetch; sleep?: (ms: number) => Promise<void>; pollMs?: number; waitMs?: number }): Venue {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 500;
  const waitMs = opts.waitMs ?? 10_000;
  const hdr = (k: Keys, json = false): Record<string, string> => ({
    'APCA-API-KEY-ID': k.key, 'APCA-API-SECRET-KEY': k.secret, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  const parseOrder = (b: unknown) => {
    if (!isObj(b) || typeof b.id !== 'string' || b.id.length > 64 || typeof b.status !== 'string') return null;
    return { id: b.id, status: b.status, filledQty: num(b.filled_qty) ?? 0, avgPx: num(b.filled_avg_price) };
  };
  return {
    id: 'alpaca-paper',
    label: VENUE_LABEL['alpaca-paper'],
    ready: () => !!opts.keys(),
    async check() {
      const k = opts.keys();
      if (!k) return { ok: false, reason: 'no Alpaca key saved' };
      const r = await opts.http(`${ALPACA_PAPER}/account`, { headers: hdr(k) });
      if (r.status !== 200 || !isObj(r.body)) return { ok: false, reason: errText(r.body, r.status) };
      const bp = num(r.body.buying_power);
      return { ok: true, detail: `paper account ${String(r.body.status ?? '').slice(0, 16)}${bp !== null ? `, buying power $${Math.round(bp).toLocaleString('en-US')}` : ''}` };
    },
    async submit(o) {
      const k = opts.keys();
      if (!k) return { ok: false, reason: 'no Alpaca key saved' };
      if (!/^[A-Z.]{1,12}$/.test(o.symbol)) return { ok: false, reason: `${o.symbol} is not a US stock` };
      const qty = qtyStr(o.qty, 6);
      if (Number(qty) <= 0) return { ok: false, reason: 'size rounds to zero' };
      const body = { symbol: o.symbol, qty, side: o.side.toLowerCase(), type: 'market', time_in_force: 'day', client_order_id: `bourse-${randomUUID()}` };
      const r = await opts.http(`${ALPACA_PAPER}/orders`, { method: 'POST', headers: hdr(k, true), body: JSON.stringify(body) });
      let ord = parseOrder(r.body);
      if (r.status !== 200 || !ord) return { ok: false, reason: errText(r.body, r.status) };
      const until = Date.now() + waitMs;
      while (ord.status !== 'filled' && !['canceled', 'expired', 'rejected'].includes(ord.status) && Date.now() < until) {
        await sleep(pollMs);
        const g = await opts.http(`${ALPACA_PAPER}/orders/${encodeURIComponent(ord.id)}`, { headers: hdr(k) });
        ord = (g.status === 200 && parseOrder(g.body)) || ord;
      }
      if (ord.status !== 'filled') {
        // Book what did fill; cancel the rest so the paper book and the broker can't drift further apart.
        if (!['canceled', 'expired', 'rejected'].includes(ord.status)) await opts.http(`${ALPACA_PAPER}/orders/${encodeURIComponent(ord.id)}`, { method: 'DELETE', headers: hdr(k) }).catch(() => undefined);
        if (!(ord.filledQty > 0) || ord.avgPx === null) return { ok: false, reason: `order ${ord.status === 'rejected' ? 'rejected' : `not filled (${ord.status})`}` };
        return { ok: true, fill: { qty: ord.filledQty, price: ord.avgPx, orderId: ord.id }, note: `partly filled, rest cancelled` };
      }
      if (!(ord.filledQty > 0) || ord.avgPx === null || ord.avgPx <= 0) return { ok: false, reason: 'filled with no price' };
      return { ok: true, fill: { qty: ord.filledQty, price: ord.avgPx, orderId: ord.id } };
    },
  };
}

// ---- Binance spot testnet (crypto) -------------------------------------------------------------------------------

interface LotRules {
  step: number;
  minQty: number;
  minNotional: number;
}

export function parseLotRules(body: unknown, pair: string): LotRules | null {
  if (!isObj(body) || !Array.isArray(body.symbols)) return null;
  const s = body.symbols.find((x) => isObj(x) && x.symbol === pair);
  if (!isObj(s) || !Array.isArray(s.filters)) return null;
  let step = 0;
  let minQty = 0;
  let minNotional = 0;
  for (const f of s.filters) {
    if (!isObj(f)) continue;
    if (f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE') {
      step = Math.max(step, num(f.stepSize) ?? 0);
      minQty = Math.max(minQty, num(f.minQty) ?? 0);
    }
    if (f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') minNotional = Math.max(minNotional, num(f.minNotional) ?? 0);
  }
  return step > 0 ? { step, minQty, minNotional } : null;
}

/** Round down to the venue's step, never up: core already sized the order inside the clip. */
export function toStep(qty: number, step: number): number {
  const dp = Math.max(0, Math.min(8, Math.round(-Math.log10(step))));
  return Number(qtyStr(Math.floor(qty / step + 1e-9) * step, dp));
}

export function binanceTestnet(opts: { keys: () => Keys | undefined; http: HttpFetch; now?: () => number }): Venue {
  const now = opts.now ?? Date.now;
  const rules = new Map<string, LotRules>();
  const sign = (k: Keys, params: Record<string, string>): string => {
    const q = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(now()) }).toString();
    return `${q}&signature=${createHmac('sha256', k.secret).update(q).digest('hex')}`;
  };
  const pairOf = (symbol: string): string | null => (/^[A-Z0-9]{2,12}-USDT$/.test(symbol) ? symbol.replace('-', '') : null);
  return {
    id: 'binance-testnet',
    label: VENUE_LABEL['binance-testnet'],
    ready: () => !!opts.keys(),
    async check() {
      const k = opts.keys();
      if (!k) return { ok: false, reason: 'no Binance testnet key saved' };
      const r = await opts.http(`${BINANCE_TESTNET}/v3/account?${sign(k, { omitZeroBalances: 'true' })}`, { headers: { 'X-MBX-APIKEY': k.key } });
      if (r.status !== 200 || !isObj(r.body)) return { ok: false, reason: errText(r.body, r.status) };
      const bal = Array.isArray(r.body.balances) ? r.body.balances : [];
      const usdt = bal.find((b) => isObj(b) && b.asset === 'USDT');
      const free = isObj(usdt) ? num(usdt.free) : null;
      return { ok: true, detail: `testnet account${free !== null ? `, ${Math.round(free).toLocaleString('en-US')} USDT free` : ''}` };
    },
    async submit(o) {
      const k = opts.keys();
      if (!k) return { ok: false, reason: 'no Binance testnet key saved' };
      const pair = pairOf(o.symbol);
      if (!pair) return { ok: false, reason: `${o.symbol} is not a USDT pair` };
      let lot = rules.get(pair);
      if (!lot) {
        const r = await opts.http(`${BINANCE_TESTNET}/v3/exchangeInfo?symbol=${pair}`);
        const parsed = r.status === 200 ? parseLotRules(r.body, pair) : null;
        if (!parsed) return { ok: false, reason: r.status === 200 ? `${pair} is not listed on the testnet` : errText(r.body, r.status) };
        rules.set(pair, (lot = parsed));
      }
      const qty = toStep(o.qty, lot.step);
      if (qty <= 0 || qty < lot.minQty) return { ok: false, reason: `size is under the testnet's minimum for ${pair}` };
      const r = await opts.http(`${BINANCE_TESTNET}/v3/order`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': k.key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: sign(k, { symbol: pair, side: o.side, type: 'MARKET', quantity: qtyStr(qty), newOrderRespType: 'FULL', newClientOrderId: `bourse-${randomUUID().slice(0, 24)}` }),
      });
      const b = r.body;
      if (r.status !== 200 || !isObj(b)) return { ok: false, reason: errText(b, r.status) };
      const filled = num(b.executedQty) ?? 0;
      const quote = num(b.cummulativeQuoteQty) ?? 0;
      const id = num(b.orderId);
      if (!(filled > 0) || !(quote > 0) || id === null) return { ok: false, reason: `order ${typeof b.status === 'string' ? b.status.toLowerCase().slice(0, 24) : 'not filled'}` };
      return { ok: true, fill: { qty: filled, price: quote / filled, orderId: String(id) }, ...(b.status !== 'FILLED' ? { note: 'partly filled' } : {}) };
    },
  };
}

/** Wrap global fetch: JSON body or null, status kept, 10 s timeout. */
export const httpFetch: HttpFetch = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { msg: text.slice(0, 160) };
  }
  return { status: r.status, body };
};
