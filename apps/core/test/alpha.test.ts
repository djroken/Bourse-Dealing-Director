import { describe, expect, it } from 'vitest';
import { createScorebook } from '../src/scorecard';
import { createEngine } from '../src/engine';
import { tally } from '../src/league';
import { SnapshotSchema } from '../src/persist';

const base = { agentId: 'A', role: 'Quant / Signals', name: 'Pico', model: 'ollama:x', temperature: 0.3, autonomy: 'SUGGEST' as const, size: 1, confidence: 0.6, rationale: 'r', change24h: 1, source: 'binance' };

describe('scoring against the market', () => {
  it('a long that rose less than BTC loses to the market; a short that fell more than BTC beats it; the benchmark itself is scored vs cash', () => {
    let t = 0;
    const btc = { px: 100 };
    const sb = createScorebook({ now: () => t, horizonMs: 1000, priceOf: (s) => (s === 'BTC-USDT' ? btc.px : undefined) });
    sb.idea({ ...base, symbol: 'SOL-USDT', side: 'BUY', price: 200, bench: { symbol: 'BTC-USDT', price: 100 } });
    sb.idea({ ...base, symbol: 'ETH-USDT', side: 'SELL', price: 50, bench: { symbol: 'BTC-USDT', price: 100 } });
    sb.idea({ ...base, symbol: 'BTC-USDT', side: 'BUY', price: 100, bench: { symbol: 'BTC-USDT', price: 100 } });
    sb.idea({ ...base, symbol: 'XRP-USDT', side: 'BUY', price: 2 }); // no benchmark known: raw score only
    t = 1000;
    btc.px = 103; // BTC +3%
    const sol = sb.tick('SOL-USDT', 202)[0]!.outcome!; // +1%
    expect(sol).toMatchObject({ returnPct: 1, correct: true, benchmark: { symbol: 'BTC-USDT', returnPct: 3 }, alphaPct: -2 });
    btc.px = 96; // BTC -4%
    const eth = sb.tick('ETH-USDT', 47.5)[0]!.outcome!; // fell 5%: +5% for the short
    expect(eth).toMatchObject({ returnPct: 5, alphaPct: 1 });
    expect(sb.tick('BTC-USDT', 96)[0]!.outcome).toMatchObject({ returnPct: -4, alphaPct: -4 });
    const xrp = sb.tick('XRP-USDT', 2.1)[0]!.outcome!;
    expect(xrp.alphaPct).toBeUndefined();
    expect(sb.cardOf('A')).toMatchObject({ scored: 4, alphaScored: 3, avgAlphaPct: -1.6667 });
  });

  it('the engine attaches BTC as the benchmark for coins once BTC has a price, and SPY for stocks', () => {
    const e = createEngine({ cooldownMs: 0 });
    e.pushTick('SOL-USDT', { price: 215, change24h: 4, source: 'binance' });
    expect(e.ideas().every((i) => i.bench === undefined)).toBe(true); // no BTC price yet
    e.pushTick('BTC-USDT', { price: 96_000, change24h: 1, source: 'binance' });
    e.pushTick('SOL-USDT', { price: 216, change24h: 4.2, source: 'binance' });
    expect(e.ideas().filter((i) => i.symbol === 'SOL-USDT').at(-1)!.bench).toEqual({ symbol: 'BTC-USDT', price: 96_000 });
  });

  it('the league ranks by the move net of the market, and counts ideas that beat it', () => {
    const rec = (id: string, model: string, returnPct: number, alphaPct?: number) => ({ id, model, role: 'Quant / Signals', ts: 1, outcome: { returnPct, correct: returnPct > 0, ...(alphaPct === undefined ? {} : { alphaPct }) } });
    const rows = tally([rec('1', 'ollama:rides-beta', 3, -0.5), rec('2', 'ollama:rides-beta', 2, -0.5), rec('3', 'ollama:picks', 0.5, 0.8), rec('4', 'ollama:picks', 0.2, 0.4)] as never);
    expect(rows.map((r) => [r.model, r.avgAlphaPct, r.beat])).toEqual([['ollama:picks', 0.6000000000000001, 2], ['ollama:rides-beta', -0.5, 0]]);
  });

  it('alpha and the fallback flag survive a save and load', () => {
    const idea = { ...base, id: 'I1', ts: 1, symbol: 'SOL-USDT', side: 'BUY', price: 1, filled: false, fallback: true, bench: { symbol: 'BTC-USDT', price: 1 }, outcome: { horizonMs: 1, exitPrice: 1, returnPct: 1, correct: true, benchmark: { symbol: 'BTC-USDT', returnPct: 0.5 }, alphaPct: 0.5 } };
    const parsed = SnapshotSchema.shape.scores.shape.ideas.element.parse(idea);
    expect(parsed).toMatchObject({ fallback: true, bench: { symbol: 'BTC-USDT' }, outcome: { alphaPct: 0.5, benchmark: { returnPct: 0.5 } } });
  });
});
