import type { PriceMsg } from './feeds';

/**
 * Alpaca market data for US stocks: free with a paper-trading account key (IEX feed). Read-only: nothing here can
 * place an order. Keys are read at call time from core's encrypted store (or env), never sent to the browser.
 */

export interface AlpacaKeys {
  key: string;
  secret: string;
}
export type HeaderFetch = (url: string, init?: RequestInit) => Promise<unknown>;

const DATA = 'https://data.alpaca.markets/v2';
const CLOCK = 'https://paper-api.alpaca.markets/v2/clock';

const headers = (k: AlpacaKeys): RequestInit => ({ headers: { 'APCA-API-KEY-ID': k.key, 'APCA-API-SECRET-KEY': k.secret, Accept: 'application/json' } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Snapshots are keyed by symbol, either at the top level or under `snapshots`; accept both. */
export function parseSnapshots(data: unknown, symbols: string[], ts: number): PriceMsg[] {
  if (!isRecord(data)) return [];
  const root = isRecord(data.snapshots) ? data.snapshots : data;
  const out: PriceMsg[] = [];
  for (const sym of symbols) {
    const s = root[sym];
    if (!isRecord(s)) continue;
    const trade = isRecord(s.latestTrade) ? num(s.latestTrade.p) : null;
    const bar = isRecord(s.minuteBar) ? num(s.minuteBar.c) : null;
    const price = trade ?? bar;
    if (price === null || price <= 0) continue;
    const prev = isRecord(s.prevDailyBar) ? num(s.prevDailyBar.c) : null;
    // For stocks "24h change" is the change from the previous session's close, which is how stock moves are quoted.
    const change24h = prev !== null && prev > 0 ? Number((((price - prev) / prev) * 100).toFixed(2)) : null;
    out.push({ type: 'price', symbol: sym, price, change24h, source: 'alpaca', ts });
  }
  return out;
}

export async function fetchStockQuotes(fetchJson: HeaderFetch, keys: AlpacaKeys, symbols: string[], ts: number): Promise<PriceMsg[]> {
  if (!symbols.length) return [];
  const data = await fetchJson(`${DATA}/stocks/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=iex`, headers(keys));
  return parseSnapshots(data, symbols, ts);
}

/** Regular US session, Mon-Fri 09:30-16:00 New York time. Used when Alpaca's clock can't be reached; ignores holidays. */
export function usSessionOpen(now: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export interface MarketClock {
  open: boolean;
  nextOpen: string | null;
  nextClose: string | null;
  /** 'alpaca' when Alpaca's clock answered (holidays included), 'schedule' when this fell back to regular hours. */
  from: 'alpaca' | 'schedule';
}

export async function fetchClock(fetchJson: HeaderFetch, keys: AlpacaKeys, now: number): Promise<MarketClock> {
  try {
    const c = await fetchJson(CLOCK, headers(keys));
    if (isRecord(c) && typeof c.is_open === 'boolean') {
      return { open: c.is_open, nextOpen: typeof c.next_open === 'string' ? c.next_open : null, nextClose: typeof c.next_close === 'string' ? c.next_close : null, from: 'alpaca' };
    }
  } catch {
    /* fall through to the schedule */
  }
  return { open: usSessionOpen(now), nextOpen: null, nextClose: null, from: 'schedule' };
}

const TF: Record<string, string> = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '4h': '4Hour', '1d': '1Day' };

/** Bars for one symbol, oldest first. Follows next_page_token. Accepts `bars` as an array or keyed by symbol. */
export async function fetchStockBars(
  fetchJson: HeaderFetch,
  keys: AlpacaKeys,
  symbol: string,
  tf: keyof typeof TF | string,
  from: number,
  to: number,
  opts: { max?: number; isCancelled?: () => boolean } = {},
): Promise<Array<{ t: number; o: number; h: number; l: number; c: number }>> {
  const timeframe = TF[tf];
  if (!timeframe) throw new Error(`unsupported timeframe ${tf}`);
  const max = opts.max ?? 50_000;
  const out: Array<{ t: number; o: number; h: number; l: number; c: number }> = [];
  let token: string | null = null;
  for (let page = 0; page < 100 && out.length < max; page++) {
    if (opts.isCancelled?.()) throw new Error('cancelled');
    const q = new URLSearchParams({ timeframe, start: new Date(from).toISOString(), end: new Date(to).toISOString(), limit: '10000', feed: 'iex', adjustment: 'split', sort: 'asc' });
    if (token) q.set('page_token', token);
    const data = await fetchJson(`${DATA}/stocks/${encodeURIComponent(symbol)}/bars?${q}`, headers(keys));
    if (!isRecord(data)) break;
    const raw = Array.isArray(data.bars) ? data.bars : isRecord(data.bars) && Array.isArray(data.bars[symbol]) ? (data.bars[symbol] as unknown[]) : [];
    for (const b of raw) {
      if (!isRecord(b)) continue;
      const t = typeof b.t === 'string' ? Date.parse(b.t) : NaN;
      const [o, h, l, c] = [num(b.o), num(b.h), num(b.l), num(b.c)];
      if (Number.isFinite(t) && o && h && l && c && c > 0 && h >= l) out.push({ t, o, h, l, c });
    }
    token = typeof data.next_page_token === 'string' && data.next_page_token ? data.next_page_token : null;
    if (!token) break;
  }
  return out.slice(0, max);
}
