import { DEFAULT_CRYPTO, type Instrument } from './instruments';

export type FeedSource = 'binance' | 'coinbase' | 'frankfurter' | 'hyperliquid' | 'alpaca';

export interface PriceMsg {
  type: 'price';
  symbol: string;
  price: number;
  change24h: number | null;
  source: FeedSource;
  ts: number;
  /** Stocks only: whether the US market is in its regular session. Crypto never closes. */
  marketOpen?: boolean;
}
export interface FundingMsg {
  type: 'funding';
  symbol: string;
  /** Funding rate for one period (see periodHours), as a fraction: 0.0001 = 0.01%. */
  rate: number;
  /** Binance settles every 8h; Hyperliquid every 1h. */
  periodHours: number;
  source: FeedSource;
  ts: number;
}
export type FeedMsg = PriceMsg | FundingMsg;

/** The crypto feed's view of an instrument. */
export interface CryptoFeed {
  binance: string;
  display: string;
  coinbase: string | null;
  coin: string;
}
export const cryptoFeeds = (list: Instrument[]): CryptoFeed[] =>
  list.filter((i) => i.kind === 'crypto' && i.binance && i.coin).map((i) => ({ binance: i.binance!, display: i.symbol, coinbase: i.coinbase ?? null, coin: i.coin! }));
export const CRYPTO: CryptoFeed[] = cryptoFeeds(DEFAULT_CRYPTO);
export const FX_PAIRS = ['USD-EUR', 'USD-GBP', 'USD-JPY'];

const BINANCE_SPOT = 'https://data-api.binance.vision/api/v3';
const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1';
const COINBASE = 'https://api.exchange.coinbase.com';
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';
const FRANKFURTER = 'https://api.frankfurter.app/latest?from=USD';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- parsers (pure: payload in, message out, null when the payload isn't what we expect) -------------------------

export function parseBinance24h(data: unknown, display: string, ts: number): PriceMsg | null {
  if (!isRecord(data)) return null;
  const price = num(data.lastPrice);
  if (price === null || price <= 0) return null;
  return { type: 'price', symbol: display, price, change24h: num(data.priceChangePercent), source: 'binance', ts };
}

export function parseCoinbase(ticker: unknown, stats: unknown, display: string, ts: number): PriceMsg | null {
  if (!isRecord(ticker)) return null;
  const price = num(ticker.price);
  if (price === null || price <= 0) return null;
  const open = isRecord(stats) ? num(stats.open) ?? num(stats.open_24h) : null;
  const change24h = open !== null && open > 0 ? Number((((price - open) / open) * 100).toFixed(2)) : null;
  return { type: 'price', symbol: display, price, change24h, source: 'coinbase', ts };
}

export function parseFrankfurter(data: unknown, pairs: string[], ts: number): PriceMsg[] {
  if (!isRecord(data) || !isRecord(data.rates)) return [];
  const out: PriceMsg[] = [];
  for (const pair of pairs) {
    const rate = num(data.rates[pair.split('-')[1] ?? '']);
    if (rate !== null && rate > 0) out.push({ type: 'price', symbol: pair, price: rate, change24h: null, source: 'frankfurter', ts });
  }
  return out;
}

export function parseBinanceFunding(data: unknown, coin: string, ts: number): FundingMsg | null {
  if (!isRecord(data)) return null;
  const rate = num(data.lastFundingRate);
  return rate === null ? null : { type: 'funding', symbol: coin, rate, periodHours: 8, source: 'binance', ts };
}

/** Hyperliquid `metaAndAssetCtxs` is `[ { universe: [{ name }] }, [ { funding }, ... ] ]`, aligned by index. */
export function parseHyperliquidFunding(data: unknown, coins: string[], ts: number): FundingMsg[] {
  if (!Array.isArray(data) || data.length < 2) return [];
  const meta: unknown = data[0];
  const ctxs: unknown = data[1];
  if (!isRecord(meta) || !Array.isArray(meta.universe) || !Array.isArray(ctxs)) return [];
  const out: FundingMsg[] = [];
  for (const coin of coins) {
    const i = meta.universe.findIndex((u: unknown) => isRecord(u) && u.name === coin);
    const ctx: unknown = i >= 0 ? ctxs[i] : undefined;
    const rate = isRecord(ctx) ? num(ctx.funding) : null;
    if (rate !== null) out.push({ type: 'funding', symbol: coin, rate, periodHours: 1, source: 'hyperliquid', ts });
  }
  return out;
}

// ---- fetching ----------------------------------------------------------------------------------------------------

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  init?: RequestInit;
}

export async function fetchJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  const { retries = 2, timeoutMs = 6000, backoffMs = 1000, fetchImpl = fetch, init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface FeedDeps {
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
  now: () => number;
}

/** One full poll. Each source degrades independently: a failure drops that source's messages, never the whole poll. */
export async function pollFeeds(deps: FeedDeps, crypto: CryptoFeed[] = CRYPTO): Promise<FeedMsg[]> {
  const CRYPTO = crypto;
  const ts = deps.now();
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const prices = await Promise.all(
    CRYPTO.map(async (c) => {
      const fromBinance = await safe(async () => parseBinance24h(await deps.fetchJson(`${BINANCE_SPOT}/ticker/24hr?symbol=${c.binance}`), c.display, ts), null);
      if (fromBinance) return fromBinance;
      if (!c.coinbase) return null;
      const cb = c.coinbase;
      // Coinbase quotes USD, which stands in for USDT when Binance is unreachable (e.g. blocked regions).
      return safe(async () => {
        const [ticker, stats] = await Promise.all([
          deps.fetchJson(`${COINBASE}/products/${cb}/ticker`),
          deps.fetchJson(`${COINBASE}/products/${cb}/stats`),
        ]);
        return parseCoinbase(ticker, stats, c.display, ts);
      }, null);
    }),
  );

  const fx = await safe(async () => parseFrankfurter(await deps.fetchJson(FRANKFURTER), FX_PAIRS, ts), [] as PriceMsg[]);

  const binanceFunding = await Promise.all(
    CRYPTO.map((c) => safe(async () => parseBinanceFunding(await deps.fetchJson(`${BINANCE_FUTURES}/premiumIndex?symbol=${c.binance}`), c.coin, ts), null)),
  );
  const got = new Set(binanceFunding.filter((f): f is FundingMsg => f !== null).map((f) => f.symbol));
  const missing = CRYPTO.map((c) => c.coin).filter((coin) => !got.has(coin));
  const hyperliquid = missing.length
    ? await safe(
        async () =>
          parseHyperliquidFunding(
            await deps.fetchJson(HYPERLIQUID, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }),
            missing,
            ts,
          ),
        [] as FundingMsg[],
      )
    : [];

  return [
    ...(prices.filter((p) => p !== null) as PriceMsg[]),
    ...fx,
    ...(binanceFunding.filter((f) => f !== null) as FundingMsg[]),
    ...hyperliquid,
  ];
}
