import { describe, expect, it } from 'vitest';
import { applyFill, mark, newBook } from '../src/book';

const px = (o: Record<string, number>) => new Map(Object.entries(o));

describe('paper book', () => {
  it('averages the cost of adds and marks unrealised P&L', () => {
    const b = newBook();
    applyFill(b, 'BTC', 'BUY', 1, 100);
    applyFill(b, 'BTC', 'BUY', 1, 200);
    expect(b.positions.get('BTC')).toEqual({ qty: 2, avg: 150 });
    const v = mark(b, px({ BTC: 180 }));
    expect(v.pnl).toBe(60);
    expect(v.exposure).toBe(360);
  });
  it('a short makes money when price falls', () => {
    const b = newBook();
    applyFill(b, 'ETH', 'SELL', 10, 100);
    expect(mark(b, px({ ETH: 90 })).pnl).toBe(100);
    expect(mark(b, px({ ETH: 110 })).pnl).toBe(-100);
  });
  it('realises P&L on a partial close and keeps the average on the remainder', () => {
    const b = newBook();
    applyFill(b, 'BTC', 'BUY', 4, 100);
    applyFill(b, 'BTC', 'SELL', 1, 120);
    expect(b.realized).toBe(20);
    expect(b.positions.get('BTC')).toEqual({ qty: 3, avg: 100 });
    expect(mark(b, px({ BTC: 100 })).pnl).toBe(20);
  });
  it('closing flat removes the position', () => {
    const b = newBook();
    applyFill(b, 'BTC', 'BUY', 2, 100);
    applyFill(b, 'BTC', 'SELL', 2, 90);
    expect(b.positions.size).toBe(0);
    expect(b.realized).toBe(-20);
  });
  it('flipping through zero realises the closed part and re-opens at the fill price', () => {
    const b = newBook();
    applyFill(b, 'BTC', 'BUY', 1, 100);
    applyFill(b, 'BTC', 'SELL', 3, 110);
    expect(b.realized).toBe(10);
    expect(b.positions.get('BTC')).toEqual({ qty: -2, avg: 110 });
  });
  it('a position with no price yet carries at cost', () => {
    const b = newBook();
    applyFill(b, 'BTC', 'BUY', 1, 100);
    expect(mark(b, px({})).pnl).toBe(0);
  });
  it('ignores nonsense fills', () => {
    const b = newBook();
    for (const [u, p] of [[0, 100], [-1, 100], [1, 0], [Number.NaN, 5], [1, Number.NaN]] as const) applyFill(b, 'BTC', 'BUY', u, p);
    expect(b.positions.size).toBe(0);
    expect(b.realized).toBe(0);
  });
});
