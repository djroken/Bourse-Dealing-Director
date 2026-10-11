import { describe, expect, it } from 'vitest';
import {
  fetchJson, parseBinance24h, parseBinanceFunding, parseCoinbase, parseFrankfurter, parseHyperliquidFunding, pollFeeds,
} from '../src/feeds';

const TS = 1_700_000_000_000;

describe('parsers', () => {
  it('parses a Binance 24h ticker', () => {
    expect(parseBinance24h({ lastPrice: '86712.50', priceChangePercent: '-1.25' }, 'BTC-USDT', TS)).toEqual({
      type: 'price', symbol: 'BTC-USDT', price: 86712.5, change24h: -1.25, source: 'binance', ts: TS,
    });
  });
  it('rejects bad Binance payloads', () => {
    expect(parseBinance24h(null, 'BTC-USDT', TS)).toBeNull();
    expect(parseBinance24h({ lastPrice: 'abc' }, 'BTC-USDT', TS)).toBeNull();
    expect(parseBinance24h({ lastPrice: '0' }, 'BTC-USDT', TS)).toBeNull();
    expect(parseBinance24h({ code: -1121, msg: 'Invalid symbol.' }, 'BTC-USDT', TS)).toBeNull();
  });

  it('derives 24h change from Coinbase ticker + stats (stats.open)', () => {
    const m = parseCoinbase({ price: '110' }, { open: '100' }, 'BTC-USDT', TS);
    expect(m).toMatchObject({ price: 110, change24h: 10, source: 'coinbase' });
  });
  it('still prices Coinbase when stats are missing', () => {
    expect(parseCoinbase({ price: '110' }, null, 'BTC-USDT', TS)).toMatchObject({ price: 110, change24h: null });
  });

  it('parses Frankfurter rates and skips missing currencies', () => {
    const out = parseFrankfurter({ rates: { EUR: 0.92, GBP: 0.78 } }, ['USD-EUR', 'USD-GBP', 'USD-JPY'], TS);
    expect(out.map((m) => [m.symbol, m.price])).toEqual([['USD-EUR', 0.92], ['USD-GBP', 0.78]]);
    expect(parseFrankfurter({}, ['USD-EUR'], TS)).toEqual([]);
  });

  it('parses Binance funding (8h)', () => {
    expect(parseBinanceFunding({ lastFundingRate: '0.00010000' }, 'BTC', TS)).toMatchObject({ rate: 0.0001, periodHours: 8 });
    expect(parseBinanceFunding({}, 'BTC', TS)).toBeNull();
  });

  it('maps Hyperliquid metaAndAssetCtxs by index (1h)', () => {
    const data = [
      { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] },
      [{ funding: '0.0000125' }, { funding: '-0.00002' }, { funding: '0.00001' }],
    ];
    const out = parseHyperliquidFunding(data, ['ETH', 'BTC', 'DOGE'], TS);
    expect(out.map((m) => [m.symbol, m.rate, m.periodHours])).toEqual([['ETH', -0.00002, 1], ['BTC', 0.0000125, 1]]);
    expect(parseHyperliquidFunding({ not: 'an array' }, ['BTC'], TS)).toEqual([]);
    expect(parseHyperliquidFunding([{}, []], ['BTC'], TS)).toEqual([]);
  });
});

describe('fetchJson', () => {
  it('retries then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3 ? new Response('no', { status: 500 }) : new Response(JSON.stringify({ ok: 1 }));
    }) as typeof fetch;
    await expect(fetchJson('http://x', { fetchImpl, backoffMs: 1 })).resolves.toEqual({ ok: 1 });
    expect(calls).toBe(3);
  });
  it('throws after exhausting retries', async () => {
    const fetchImpl = (async () => new Response('no', { status: 503 })) as typeof fetch;
    await expect(fetchJson('http://x', { fetchImpl, retries: 1, backoffMs: 1 })).rejects.toThrow(/HTTP 503/);
  });
  it('aborts a hung request', async () => {
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    await expect(fetchJson('http://x', { fetchImpl, retries: 0, timeoutMs: 10 })).rejects.toThrow(/aborted/);
  });
});

describe('pollFeeds', () => {
  const route =
    (table: Record<string, unknown>) =>
    async (url: string): Promise<unknown> => {
      for (const [needle, body] of Object.entries(table)) if (url.includes(needle)) return body;
      throw new Error('unreachable: ' + url);
    };
  const binanceOk = (sym: string, last: string) => [`ticker/24hr?symbol=${sym}`, { lastPrice: last, priceChangePercent: '1.5' }] as const;

  it('uses the Binance public data endpoint and Hyperliquid funding when futures are blocked', async () => {
    const urls: string[] = [];
    const table = route({
      'ticker/24hr?symbol=BTCUSDT': { lastPrice: '100', priceChangePercent: '2' },
      'ticker/24hr?symbol=ETHUSDT': { lastPrice: '10', priceChangePercent: '-1' },
      'ticker/24hr?symbol=SOLUSDT': { lastPrice: '1', priceChangePercent: '0' },
      'frankfurter.app': { rates: { EUR: 0.9, GBP: 0.8, JPY: 150 } },
      'api.hyperliquid.xyz/info': [{ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] }, [{ funding: '0.00001' }, { funding: '0.00002' }, { funding: '0.00003' }]],
    });
    const msgs = await pollFeeds({
      now: () => TS,
      fetchJson: async (url, init) => {
        urls.push(url);
        return table(url);
      },
    });
    expect(urls.some((u) => u.startsWith('https://data-api.binance.vision/api/v3/ticker/24hr'))).toBe(true);
    expect(urls.some((u) => u.includes('api.hyperliquid.info'))).toBe(false); // the old, non-existent host
    expect(msgs.filter((m) => m.type === 'price').map((m) => m.symbol).sort()).toEqual(
      ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'USD-EUR', 'USD-GBP', 'USD-JPY'].sort(),
    );
    const funding = msgs.filter((m) => m.type === 'funding');
    expect(funding).toHaveLength(3);
    expect(funding.every((f) => f.source === 'hyperliquid')).toBe(true);
  });

  it('falls back to Coinbase per symbol, and one dead source does not sink the poll', async () => {
    const table = route({
      ...Object.fromEntries([binanceOk('BTCUSDT', '100')]),
      'products/ETH-USD/ticker': { price: '11' },
      'products/ETH-USD/stats': { open: '10' },
      // SOL: Binance and Coinbase both fail. FX and funding fail too.
    });
    const msgs = await pollFeeds({ now: () => TS, fetchJson: async (u) => table(u) });
    const prices = msgs.filter((m) => m.type === 'price');
    expect(prices.map((m) => `${m.symbol}:${m.source}`).sort()).toEqual(['BTC-USDT:binance', 'ETH-USDT:coinbase']);
  });

  it('returns nothing, without throwing, when everything is down', async () => {
    const msgs = await pollFeeds({ now: () => TS, fetchJson: async () => { throw new Error('offline'); } });
    expect(msgs).toEqual([]);
  });
});
