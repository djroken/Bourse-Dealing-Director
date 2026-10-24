import { describe, expect, it } from 'vitest';
import { fetchClock, fetchStockBars, parseSnapshots, usSessionOpen } from '../src/alpaca';
import { loadConfig } from '../src/config';
import { createEngine } from '../src/engine';
import { buildInstruments, DEFAULT_CRYPTO } from '../src/instruments';
import { createMcpServer } from '../src/mcp';
import type { SecretStore } from '../src/secrets';
import { buildServer } from '../src/server';

const TS = Date.UTC(2026, 9, 21, 15, 0); // a Wednesday, 11:00 in New York

describe('instruments', () => {
  it('crypto by default: BTC, ETH, SOL, BNB, XRP; extras from BOURSE_CRYPTO; stocks only with a key', () => {
    expect(buildInstruments({ stocksEnabled: false }).instruments.map((i) => i.symbol)).toEqual(['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT']);
    const extra = buildInstruments({ extraCrypto: 'doge, ADA, btc, x!y', stocksEnabled: false });
    expect(extra.instruments.map((i) => i.symbol)).toContain('DOGE-USDT');
    expect(extra.instruments.filter((i) => i.symbol === 'BTC-USDT')).toHaveLength(1);
    expect(extra.warnings).toEqual(['BOURSE_CRYPTO: "X!Y" is not a coin symbol; skipped']);
    expect(buildInstruments({ stocks: 'AAPL', stocksEnabled: false }).warnings[0]).toMatch(/no Alpaca key/);
    const stocks = buildInstruments({ stocksEnabled: true });
    expect(stocks.instruments.filter((i) => i.kind === 'stock').map((i) => i.symbol)).toEqual(['SPY', 'AAPL', 'NVDA', 'TSLA']);
    const own = buildInstruments({ stocks: 'msft, BRK.B, toolongticker', stocksEnabled: true });
    expect(own.instruments.filter((i) => i.kind === 'stock').map((i) => i.symbol)).toEqual(['MSFT', 'BRK.B']);
    expect(own.warnings).toHaveLength(1);
    expect(DEFAULT_CRYPTO.find((i) => i.coin === 'BNB')!.coinbase).toBeNull();
  });
});

describe('alpaca parsing', () => {
  const snap = (p: number, prev: number) => ({ latestTrade: { t: '2026-10-21T15:00:00Z', p }, prevDailyBar: { c: prev }, minuteBar: { c: p } });
  it('reads snapshots keyed at the top level or under `snapshots`; change is from the previous close', () => {
    for (const body of [{ AAPL: snap(110, 100), MSFT: snap(50, 50) }, { snapshots: { AAPL: snap(110, 100), MSFT: snap(50, 50) } }]) {
      const msgs = parseSnapshots(body, ['AAPL', 'MSFT', 'NOPE'], TS);
      expect(msgs).toEqual([
        { type: 'price', symbol: 'AAPL', price: 110, change24h: 10, source: 'alpaca', ts: TS },
        { type: 'price', symbol: 'MSFT', price: 50, change24h: 0, source: 'alpaca', ts: TS },
      ]);
    }
    expect(parseSnapshots({ AAPL: { latestTrade: { p: 0 } } }, ['AAPL'], TS)).toEqual([]);
    expect(parseSnapshots('nope', ['AAPL'], TS)).toEqual([]);
  });

  it('pages bars with next_page_token, sends the key headers, and accepts either shape', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fj = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      const token = new URL(url).searchParams.get('page_token');
      if (!token) return { bars: [{ t: '2026-10-20T13:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5 }], next_page_token: 'p2' };
      return { bars: { AAPL: [{ t: '2026-10-20T13:35:00Z', o: 1.5, h: 2, l: 1, c: 1.8 }, { t: 'bad', o: 1, h: 1, l: 1, c: 1 }] }, next_page_token: null };
    };
    const bars = await fetchStockBars(fj, { key: 'K', secret: 'S' }, 'AAPL', '5m', TS - 86_400_000, TS);
    expect(bars.map((b) => b.c)).toEqual([1.5, 1.8]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toContain('/v2/stocks/AAPL/bars?');
    expect(seen[0]!.url).toContain('timeframe=5Min');
    expect(seen[0]!.url).toContain('feed=iex');
    expect(seen[0]!.headers).toMatchObject({ 'APCA-API-KEY-ID': 'K', 'APCA-API-SECRET-KEY': 'S' });
    expect(seen[1]!.url).toContain('page_token=p2');
    await expect(fetchStockBars(fj, { key: 'K', secret: 'S' }, 'AAPL', '3m', 0, 1)).rejects.toThrow(/unsupported/);
  });

  it('uses Alpaca\'s clock, and falls back to the regular session when it can\'t be reached', async () => {
    expect(await fetchClock(async () => ({ is_open: false, next_open: '2026-10-22T13:30:00Z', next_close: null }), { key: 'k', secret: 's' }, TS)).toMatchObject({ open: false, from: 'alpaca' });
    expect(await fetchClock(async () => { throw new Error('x'); }, { key: 'k', secret: 's' }, TS)).toMatchObject({ open: true, from: 'schedule' });
    expect(usSessionOpen(TS)).toBe(true);
    expect(usSessionOpen(Date.UTC(2026, 9, 21, 13, 0))).toBe(false); // 09:00 New York
    expect(usSessionOpen(Date.UTC(2026, 9, 24, 15, 0))).toBe(false); // Saturday
  });
});

describe('engine with stocks', () => {
  const stocks = buildInstruments({ stocksEnabled: true }).instruments;
  const tick = (price: number, marketOpen?: boolean) => ({ price, change24h: 3, source: 'alpaca', ...(marketOpen === undefined ? {} : { marketOpen }) });

  it('agents decide on stocks while the market is open and not after the close; orders are refused when closed', () => {
    const e = createEngine({ cooldownMs: 0, instruments: stocks });
    e.pushTick('AAPL', tick(200, true));
    expect(e.ideas().filter((r) => r.symbol === 'AAPL').length).toBeGreaterThan(0);
    const before = e.ideas().length;
    e.pushTick('AAPL', tick(201, false));
    expect(e.ideas().length).toBe(before); // closed: no new ideas
    const quant = e.agents.find((a) => a.config.role === 'Quant / Signals')!;
    expect(e.submitOrder(quant, 'AAPL', 'BUY', 1, 'Approved by operator')).toEqual({ ok: false, reason: 'The US market is closed: order not placed' });
    e.pushTick('AAPL', tick(202, true));
    expect(e.submitOrder(quant, 'AAPL', 'BUY', 1, 'Approved by operator').ok).toBe(true);
    expect(e.quotes().find((q) => q.symbol === 'AAPL')).toMatchObject({ kind: 'stock', marketOpen: true });
  });

  it('BNB and XRP trade by default; unknown symbols are refused', () => {
    const e = createEngine({ cooldownMs: 0 });
    e.pushTick('XRP-USDT', { price: 2.4, change24h: 4, source: 'binance' });
    expect(e.ideas().some((r) => r.symbol === 'XRP-USDT')).toBe(true);
    const quant = e.agents.find((a) => a.config.role === 'Quant / Signals')!;
    expect(e.submitOrder(quant, 'AAPL', 'BUY', 1, 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not traded on this floor/) });
  });

  it('MCP takes the floor\'s own instrument list', () => {
    const e = createEngine({ instruments: stocks });
    const guest = e.registerGuest('Bot')!;
    expect(() => createMcpServer(e, guest)).not.toThrow();
    expect(e.symbols()).toContain('NVDA');
  });
});

describe('server with an Alpaca key', () => {
  const store = (vals: Record<string, string>): SecretStore => ({
    get: (id) => vals[id],
    set: (id) => ({ id, updatedAt: 0 }),
    delete: () => false,
    list: () => Object.keys(vals).map((id) => ({ id, updatedAt: 0 })),
  });
  const alpaca = (url: string): unknown => {
    if (url.includes('/v2/clock')) return { is_open: true, next_open: null, next_close: '2026-10-21T20:00:00Z' };
    if (url.includes('/stocks/snapshots')) return { SPY: { latestTrade: { p: 580 }, prevDailyBar: { c: 575 } }, AAPL: { latestTrade: { p: 230 }, prevDailyBar: { c: 232 } } };
    if (url.includes('/bars')) {
      const u = new URL(url);
      const from = Date.parse(u.searchParams.get('start')!);
      const to = Date.parse(u.searchParams.get('end')!);
      const bars = [];
      for (let t = from; t <= to && bars.length < 5000; t += 3_600_000) {
        const d = new Date(t);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || d.getUTCHours() < 14 || d.getUTCHours() > 20) continue; // only session hours
        bars.push({ t: d.toISOString(), o: 100, h: 101, l: 99, c: 100 + (t / 3_600_000) % 7 });
      }
      return { bars, next_page_token: null };
    }
    throw new Error('offline');
  };

  it('lists stocks, streams their quotes with market state, serves candles, and replays a stock', async () => {
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, persist: false, ideaLog: false, stocks: 'SPY,AAPL' };
    const core = buildServer(config, { secrets: store({ 'data.alpaca.key': 'K', 'data.alpaca.secret': 'S' }), feedDeps: { now: Date.now, fetchJson: async (url) => alpaca(url) } });
    const port = await core.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      await core.pollOnce();
      const inst = (await (await fetch(`${base}/instruments`)).json()) as { instruments: Array<{ symbol: string; kind: string }>; stocks: { enabled: boolean; market: { open: boolean } | null } };
      expect(inst.instruments.filter((i) => i.kind === 'stock').map((i) => i.symbol)).toEqual(['SPY', 'AAPL']);
      expect(inst.stocks).toMatchObject({ enabled: true, market: { open: true } });
      for (let i = 0; i < 50 && !core.engine.quotes().some((q) => q.symbol === 'AAPL'); i++) await new Promise((r) => setTimeout(r, 20));
      expect(core.engine.quotes().find((q) => q.symbol === 'AAPL')).toMatchObject({ price: 230, change24h: -0.86, marketOpen: true, kind: 'stock' });

      const c = (await (await fetch(`${base}/candles?symbol=SPY&tf=1h`)).json()) as { candles: unknown[] };
      expect(c.candles.length).toBeGreaterThan(0);
      expect((await fetch(`${base}/candles?symbol=BTC-USDT`)).status).toBe(400);

      const res = await fetch(`${base}/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'AAPL', timeframe: '1h', days: 5, horizon: 1 }) });
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      let job: { status: string; error: string | null; result: { source: string; candles: number } | null } = { status: 'fetching', error: null, result: null };
      for (let i = 0; i < 200 && (job.status === 'fetching' || job.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 10));
        job = (await (await fetch(`${base}/replay/${id}`)).json()) as typeof job;
      }
      expect(job.error).toBeNull();
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ source: 'alpaca' });
      expect(job.result!.candles).toBeGreaterThan(0);
    } finally {
      await core.stop();
    }
  });

  it('without a key there are no stocks, and /instruments says so', async () => {
    const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, persist: false, ideaLog: false };
    const core = buildServer(config, { secrets: store({}), feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    const port = await core.start();
    try {
      const inst = (await (await fetch(`http://127.0.0.1:${port}/instruments`)).json()) as { instruments: Array<{ kind: string }>; stocks: { enabled: boolean; keySet: boolean } };
      expect(inst.instruments.every((i) => i.kind === 'crypto')).toBe(true);
      expect(inst.stocks).toMatchObject({ enabled: false, keySet: false });
    } finally {
      await core.stop();
    }
  });
});
