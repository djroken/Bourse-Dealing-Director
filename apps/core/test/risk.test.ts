import { describe, expect, it } from 'vitest';
import { clampClip, withinLossStop } from '../src/risk';

describe('withinLossStop', () => {
  it('allows trading while flat or in profit', () => {
    expect(withinLossStop(0, 2500)).toBe(true);
    expect(withinLossStop(1200, 2500)).toBe(true);
    // Regression: the old check was `dailyPnL < dailyLossStop`, which also "passed" a profit larger than the stop.
    expect(withinLossStop(9000, 2500)).toBe(true);
  });

  it('allows a loss that is still inside the stop', () => {
    expect(withinLossStop(-2499, 2500)).toBe(true);
  });

  it('blocks once the loss reaches the stop', () => {
    expect(withinLossStop(-2500, 2500)).toBe(false);
    expect(withinLossStop(-2501, 2500)).toBe(false);
    // Regression: the old check let this through, so the stop could never trip.
    expect(withinLossStop(-50_000, 2500)).toBe(false);
  });

  it('fails closed on bad input', () => {
    expect(withinLossStop(Number.NaN, 2500)).toBe(false);
    expect(withinLossStop(0, 0)).toBe(false);
    expect(withinLossStop(0, -5)).toBe(false);
    expect(withinLossStop(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('clampClip', () => {
  it('keeps size inside [0, maxClip]', () => {
    expect(clampClip(3, 10)).toBe(3);
    expect(clampClip(30, 10)).toBe(10);
    expect(clampClip(-4, 10)).toBe(0);
  });
  it('returns 0 for nonsense', () => {
    expect(clampClip(Number.NaN, 10)).toBe(0);
    expect(clampClip(3, 0)).toBe(0);
  });
});
