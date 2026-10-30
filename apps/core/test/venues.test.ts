import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentDecisionSchema } from 'shared';
import { createEngine, type FloorSocket } from '../src/engine';
import { loadConfig } from '../src/config';
import { buildServer } from '../src/server';
import { ALPACA_PAPER, BINANCE_TESTNET, alpacaPaper, binanceTestnet, parseLotRules, qtyStr, toStep, type HttpFetch, type Venue } from '../src/venues';

type Call = { url: string; init?: RequestInit };
/** A fake broker: answers by URL, records every call. */
function broker(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const http: HttpFetch = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    return answer(c);
  };
  return { http, calls };
}
const keys = () => ({ key: 'K', secret: 'S' });
const EXINFO = { symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5.00' }] }] };

describe('sandboxes only', () => {
  it('the venue code can only reach paper and testnet hosts, and the hosts are constants', () => {
    const src = readFileSync(new URL('../src/venues.ts', import.meta.url), 'utf8');
    expect(ALPACA_PAPER).toBe('https://paper-api.alpaca.markets/v2');
    expect(BINANCE_TESTNET).toBe('https://testnet.binance.vision/api');
    const hosts = [...src.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set(['paper-api.alpaca.markets', 'testnet.binance.vision']));
    expect(src).not.toMatch(/process\.env/); // no env var can point a venue somewhere else
  });
});

describe('helpers', () => {
  it('formats and rounds quantities down, never up', () => {
    expect(qtyStr(0.1 + 0.2)).toBe('0.3');
    expect(qtyStr(1e-7)).toBe('0.0000001');
    expect(qtyStr(1.23456789, 4)).toBe('1.2345');
    expect(toStep(0.0123456, 0.00001)).toBe(0.01234);
    expect(toStep(7.99, 1)).toBe(7);
    expect(parseLotRules(EXINFO, 'BTCUSDT')).toEqual({ step: 0.00001, minQty: 0.00001, minNotional: 5 });
    expect(parseLotRules(EXINFO, 'ETHUSDT')).toBeNull();
    expect(parseLotRules('junk', 'BTCUSDT')).toBeNull();
  });
});

describe('Binance testnet', () => {
  const venue = (answer: (c: Call) => { status: number; body: unknown }) => {
    const b = broker(answer);
    return { ...b, v: binanceTestnet({ keys, http: b.http, now: () => 1_700_000_000_000 }) };
  };
  const ok = (c: Call) =>
    c.url.includes('exchangeInfo') ? { status: 200, body: EXINFO }
    : { status: 200, body: { orderId: 42, status: 'FILLED', executedQty: '0.01234000', cummulativeQuoteQty: '1190.81' } };

  it('sends a signed MARKET order rounded to the lot step and books the average fill price', async () => {
    const { v, calls } = venue(ok);
    const r = await v.submit({ symbol: 'BTC-USDT', side: 'BUY', qty: 0.0123456 });
    expect(r).toEqual({ ok: true, fill: { qty: 0.01234, price: 1190.81 / 0.01234, orderId: '42' } });
    const order = calls.find((c) => c.url.endsWith('/v3/order'))!;
    expect(order.url).toBe(`${BINANCE_TESTNET}/v3/order`);
    expect((order.init!.headers as Record<string, string>)['X-MBX-APIKEY']).toBe('K');
    const body = String(order.init!.body);
    const params = new URLSearchParams(body);
    expect(Object.fromEntries(params)).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01234', timestamp: '1700000000000' });
    const unsigned = body.slice(0, body.indexOf('&signature='));
    expect(params.get('signature')).toBe(createHmac('sha256', 'S').update(unsigned).digest('hex'));
    await v.submit({ symbol: 'BTC-USDT', side: 'SELL', qty: 0.001 });
    expect(calls.filter((c) => c.url.includes('exchangeInfo'))).toHaveLength(1); // lot rules cached
  });
  it('passes on the exchange\'s reason, refuses tiny sizes and non-USDT symbols, and needs keys', async () => {
    const refusing = venue((c) => (c.url.includes('exchangeInfo') ? { status: 200, body: EXINFO } : { status: 400, body: { code: -2010, msg: 'Account has insufficient balance for requested action.' } }));
    expect(await refusing.v.submit({ symbol: 'BTC-USDT', side: 'SELL', qty: 1 })).toEqual({ ok: false, reason: 'Account has insufficient balance for requested action.' });
    expect(await refusing.v.submit({ symbol: 'BTC-USDT', side: 'BUY', qty: 0.000001 })).toMatchObject({ ok: false, reason: expect.stringContaining('minimum') });
    expect(await refusing.v.submit({ symbol: 'AAPL', side: 'BUY', qty: 1 })).toMatchObject({ ok: false });
    const none = binanceTestnet({ keys: () => undefined, http: broker(ok).http });
    expect(none.ready()).toBe(false);
    expect(await none.submit({ symbol: 'BTC-USDT', side: 'BUY', qty: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('no Binance testnet key') });
  });
  it('an expired market order with a partial fill books what filled', async () => {
    const { v } = venue((c) => (c.url.includes('exchangeInfo') ? { status: 200, body: EXINFO } : { status: 200, body: { orderId: 7, status: 'EXPIRED', executedQty: '0.005', cummulativeQuoteQty: '480' } }));
    expect(await v.submit({ symbol: 'BTC-USDT', side: 'BUY', qty: 0.01 })).toEqual({ ok: true, fill: { qty: 0.005, price: 96_000, orderId: '7' }, note: 'partly filled' });
  });
  it('check reads the account and reports free USDT', async () => {
    const { v, calls } = venue(() => ({ status: 200, body: { balances: [{ asset: 'USDT', free: '10000.5' }] } }));
    expect(await v.check()).toEqual({ ok: true, detail: 'testnet account, 10,001 USDT free' });
    expect(calls[0]!.url).toMatch(/^https:\/\/testnet\.binance\.vision\/api\/v3\/account\?.*signature=[0-9a-f]{64}$/);
  });
});

describe('Alpaca paper', () => {
  const noSleep = async () => {};
  it('places a market day order, polls until filled and books Alpaca\'s quantity and price', async () => {
    let polls = 0;
    const { http, calls } = broker((c) => {
      if (c.init?.method === 'POST') return { status: 200, body: { id: 'ord-1', status: 'accepted', filled_qty: '0' } };
      polls++;
      return { status: 200, body: polls < 2 ? { id: 'ord-1', status: 'partially_filled', filled_qty: '1' } : { id: 'ord-1', status: 'filled', filled_qty: '2.5', filled_avg_price: '231.4' } };
    });
    const v = alpacaPaper({ keys, http, sleep: noSleep });
    expect(await v.submit({ symbol: 'AAPL', side: 'BUY', qty: 2.5 })).toEqual({ ok: true, fill: { qty: 2.5, price: 231.4, orderId: 'ord-1' } });
    expect(calls[0]!.url).toBe(`${ALPACA_PAPER}/orders`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ symbol: 'AAPL', qty: '2.5', side: 'buy', type: 'market', time_in_force: 'day' });
    expect((calls[0]!.init!.headers as Record<string, string>)['APCA-API-KEY-ID']).toBe('K');
  });
  it('an order that doesn\'t fill in time is cancelled; a partial fill is booked as far as it went', async () => {
    const stuck = broker((c) => (c.init?.method === 'DELETE' ? { status: 204, body: null } : { status: 200, body: { id: 'o2', status: 'new', filled_qty: '0' } }));
    expect(await alpacaPaper({ keys, http: stuck.http, sleep: noSleep, waitMs: 0 }).submit({ symbol: 'NVDA', side: 'SELL', qty: 1 })).toEqual({ ok: false, reason: 'order not filled (new)' });
    expect(stuck.calls.at(-1)!.init!.method).toBe('DELETE');
    const part = broker((c) => (c.init?.method === 'DELETE' ? { status: 204, body: null } : { status: 200, body: { id: 'o3', status: 'partially_filled', filled_qty: '0.4', filled_avg_price: '140' } }));
    expect(await alpacaPaper({ keys, http: part.http, sleep: noSleep, waitMs: 0 }).submit({ symbol: 'NVDA', side: 'BUY', qty: 1 })).toEqual({ ok: true, fill: { qty: 0.4, price: 140, orderId: 'o3' }, note: 'partly filled, rest cancelled' });
  });
  it('relays a rejection and refuses crypto symbols', async () => {
    const { http } = broker(() => ({ status: 403, body: { code: 40310000, message: 'insufficient buying power' } }));
    const v = alpacaPaper({ keys, http, sleep: noSleep });
    expect(await v.submit({ symbol: 'TSLA', side: 'BUY', qty: 1 })).toEqual({ ok: false, reason: 'insufficient buying power' });
    expect(await v.submit({ symbol: 'BTC-USDT', side: 'BUY', qty: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('not a US stock') });
  });
});

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private h: Record<string, Array<(d?: unknown) => void>> = {};
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  on(e: string, cb: (d?: unknown) => void) {
    (this.h[e] ??= []).push(cb);
    return this;
  }
  emit(e: string, d?: unknown) {
    for (const cb of this.h[e] ?? []) cb(d);
  }
  of(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the engine routes owner-approved orders to the broker', () => {
  const fakeVenue = (submit: Venue['submit']): Venue & { orders: unknown[] } => {
    const orders: unknown[] = [];
    return { id: 'binance-testnet', label: 'Binance testnet', ready: () => true, check: async () => ({ ok: true, detail: '' }), orders, submit: async (o) => (orders.push(o), submit(o)) };
  };
  const floor = (venue: Venue) => {
    const engine = createEngine({ now: () => 1_000_000, route: (s) => (s === 'BTC-USDT' ? venue : undefined) });
    const ws = new FakeSocket();
    engine.addClient(ws);
    engine.pushTick('BTC-USDT', { price: 100, change24h: 0, source: 'binance' });
    engine.pushTick('ETH-USDT', { price: 50, change24h: 0, source: 'binance' });
    ws.sent.length = 0;
    const quant = engine.agents.find((a) => a.config.role === 'Quant / Signals')!;
    const order = (o: Record<string, unknown>) => ws.emit('message', JSON.stringify({ type: 'place_order', role: 'Quant / Signals', side: 'BUY', ...o }));
    return { engine, ws, quant, order };
  };

  it('books the broker\'s fill, says where it filled and how far from the market', async () => {
    const v = fakeVenue(async () => ({ ok: true, fill: { qty: 4.99, price: 101.5, orderId: '42' } }));
    const { ws, quant, order } = floor(v);
    order({ symbol: 'BTC-USDT', size: 5 });
    await flush();
    expect(v.orders).toEqual([{ symbol: 'BTC-USDT', side: 'BUY', qty: 5 }]);
    const d = ws.of('decision')[0]!;
    expect(AgentDecisionSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ action: 'BUY', size: 4.99, price: 101.5, riskChecked: true, venue: 'binance-testnet', venueOrderId: '42' });
    expect(String(d.rationale)).toBe('Approved by operator · filled on Binance testnet, order 42 (fill 1.5% from the market price) · within risk limits');
    expect(quant.book.positions.get('BTC-USDT')).toMatchObject({ qty: 4.99, avg: 101.5 });
  });
  it('symbols without a venue still fill on core\'s paper venue', () => {
    const v = fakeVenue(async () => ({ ok: false, reason: 'unused' }));
    const { ws, order } = floor(v);
    order({ symbol: 'ETH-USDT', size: 2 });
    expect(v.orders).toHaveLength(0);
    expect(ws.of('decision')[0]).toMatchObject({ action: 'BUY', size: 2, price: 50, riskChecked: true });
    expect(ws.of('decision')[0]!.venue).toBeUndefined();
  });
  it('the risk gate runs before anything reaches the broker', async () => {
    const v = fakeVenue(async () => ({ ok: true, fill: { qty: 1, price: 100, orderId: 'x' } }));
    const { engine, ws, quant, order } = floor(v);
    order({ symbol: 'BTC-USDT', size: quant.config.riskLimits.maxClip / 100 + 1 });
    engine.haltAll();
    order({ symbol: 'BTC-USDT', size: 1 });
    await flush();
    expect(v.orders).toHaveLength(0);
    expect(ws.of('decision').every((d) => d.riskChecked === false)).toBe(true);
  });
  it('a refusal, an error or an impossible fill books nothing and says why', async () => {
    for (const [submit, why] of [
      [async () => ({ ok: false as const, reason: 'Account has insufficient balance' }), 'Binance testnet refused the order: Account has insufficient balance'],
      [async () => { throw new Error('socket hang up'); }, 'Binance testnet refused the order: socket hang up'],
      [async () => ({ ok: true as const, fill: { qty: 50, price: 100, orderId: '9' } }), "Binance testnet sent a fill core can't book (order 9); check the broker account"],
    ] as const) {
      const { ws, quant, order } = floor(fakeVenue(submit));
      order({ symbol: 'BTC-USDT', size: 1 });
      await flush();
      expect(ws.of('decision')[0]).toMatchObject({ action: 'HOLD', size: 0, riskChecked: false, venue: 'binance-testnet', rationale: why });
      expect(quant.book.positions.size).toBe(0);
    }
  });
});

describe('server: /venues', () => {
  it('lists the sandboxes, toggles routing (origin-guarded), checks a key, and Live stays unavailable', async () => {
    const { http, calls } = broker((c) => (c.url.includes('/v3/account') ? { status: 200, body: { balances: [] } } : { status: 404, body: null }));
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, persist: false, ideaLog: false, talkMin: 0 };
    const prev = { k: process.env.BINANCE_TESTNET_API_KEY, s: process.env.BINANCE_TESTNET_API_SECRET };
    process.env.BINANCE_TESTNET_API_KEY = 'K';
    process.env.BINANCE_TESTNET_API_SECRET = 'S';
    const core = buildServer(config, { http, feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    const port = await core.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      const list = (await (await fetch(`${base}/venues`)).json()) as { venues: Array<Record<string, unknown>>; live: boolean };
      expect(list.live).toBe(false);
      expect(list.venues.find((v) => v.id === 'binance-testnet')).toMatchObject({ markets: 'crypto', enabled: false, keySet: true, routing: false, sandbox: true });
      const put = (body: unknown, origin?: string) => fetch(`${base}/venues/binance-testnet`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
      expect((await put({ enabled: true }, 'https://evil.example')).status).toBe(403);
      expect((await put({ enabled: 'yes' })).status).toBe(400);
      const on = (await (await put({ enabled: true }, 'http://localhost:3000')).json()) as { venues: Array<Record<string, unknown>> };
      expect(on.venues.find((v) => v.id === 'binance-testnet')).toMatchObject({ enabled: true, routing: true });
      expect((await fetch(`${base}/venues/nope`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status).toBe(404);
      expect(await (await fetch(`${base}/venues/binance-testnet/check`, { method: 'POST' })).json()).toEqual({ ok: true, detail: 'testnet account' });
      expect(calls.every((c) => c.url.startsWith(BINANCE_TESTNET))).toBe(true);
    } finally {
      await core.stop();
      process.env.BINANCE_TESTNET_API_KEY = prev.k;
      process.env.BINANCE_TESTNET_API_SECRET = prev.s;
      if (prev.k === undefined) delete process.env.BINANCE_TESTNET_API_KEY;
      if (prev.s === undefined) delete process.env.BINANCE_TESTNET_API_SECRET;
    }
  });
  it('BOURSE_VENUE_* only accept the sandbox ids', () => {
    expect(loadConfig({ BOURSE_VENUE_CRYPTO: 'binance-testnet' }).venues).toEqual({ stocks: false, crypto: true });
    expect(loadConfig({ BOURSE_VENUE_STOCKS: 'Alpaca-Paper' }).venues).toEqual({ stocks: true, crypto: false });
    expect(loadConfig({ BOURSE_VENUE_CRYPTO: 'sim' }).venues).toEqual({ stocks: false, crypto: false });
    expect(() => loadConfig({ BOURSE_VENUE_CRYPTO: 'binance' })).toThrow(/binance-testnet/);
  });
});
