/**
 * What the floor can trade. One list, built at startup from defaults plus settings, used by the feed, the engine,
 * MCP, replay and the Desk (GET /instruments). Everything else asks this module rather than hard-coding symbols.
 *
 * Crypto quotes come from Binance (Coinbase as a fallback) and need no key. US stocks come from Alpaca's free market
 * data and need a free Alpaca key; without one they are simply not on the list.
 */

export type InstrumentKind = 'crypto' | 'stock';

export interface Instrument {
  /** Core's id: "BTC-USDT" for crypto, "AAPL" for stocks. */
  symbol: string;
  kind: InstrumentKind;
  /** What the Desk shows: "BTC/USDT", "AAPL". */
  label: string;
  /** Decimals for prices. */
  dp: number;
  /** TradingView symbol for the chart widget. */
  tv: string;
  /** Crypto only. */
  binance?: string;
  coinbase?: string | null;
  coin?: string;
}

const crypto = (coin: string, dp: number, coinbase: string | null = `${coin}-USD`): Instrument => ({
  symbol: `${coin}-USDT`, kind: 'crypto', label: `${coin}/USDT`, dp, tv: `BINANCE:${coin}USDT`, binance: `${coin}USDT`, coinbase, coin,
});

/** The default crypto list. BNB has no Coinbase market, so it has no fallback feed. */
export const DEFAULT_CRYPTO: Instrument[] = [crypto('BTC', 0), crypto('ETH', 1), crypto('SOL', 2), crypto('BNB', 1, null), crypto('XRP', 4)];
export const DEFAULT_STOCKS = ['SPY', 'AAPL', 'NVDA', 'TSLA'];
const MAX_EXTRA = 12;

const COIN = /^[A-Z0-9]{2,10}$/;
const TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Build the list. `extraCrypto` are coins with a Binance USDT market (e.g. "DOGE,ADA"). `stocks` replaces the default
 * stock list and only applies when `stocksEnabled` (an Alpaca key is configured). Bad entries are reported, not thrown.
 */
export function buildInstruments(opts: { extraCrypto?: string; stocks?: string; stocksEnabled: boolean }): { instruments: Instrument[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = [...DEFAULT_CRYPTO];
  for (const coin of list(opts.extraCrypto).slice(0, MAX_EXTRA)) {
    if (!COIN.test(coin)) warnings.push(`BOURSE_CRYPTO: "${coin}" is not a coin symbol; skipped`);
    else if (!out.some((i) => i.coin === coin)) out.push(crypto(coin, 4));
  }
  if (opts.stocksEnabled) {
    const wanted = opts.stocks === undefined || opts.stocks.trim() === '' ? DEFAULT_STOCKS : list(opts.stocks);
    for (const t of wanted.slice(0, MAX_EXTRA)) {
      if (!TICKER.test(t)) warnings.push(`BOURSE_STOCKS: "${t}" is not a US ticker; skipped`);
      else if (!out.some((i) => i.symbol === t)) out.push({ symbol: t, kind: 'stock', label: t, dp: 2, tv: t });
    }
  } else if (opts.stocks && opts.stocks.trim()) {
    warnings.push('BOURSE_STOCKS is set but no Alpaca key is configured, so stocks are off');
  }
  return { instruments: out, warnings };
}

export const isStock = (i: Instrument | undefined): boolean => i?.kind === 'stock';
