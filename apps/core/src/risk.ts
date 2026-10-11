/**
 * Hard risk checks. These are plain functions on purpose: the risk gate must be trivial to read and test,
 * and no agent (or model output) can loosen it.
 */

/**
 * True while the day's P&L has not lost more than the stop.
 * `dailyPnL` is signed (losses negative); `dailyLossStop` is a positive amount, e.g. 2500 means "stop at -2500".
 */
export function withinLossStop(dailyPnL: number, dailyLossStop: number): boolean {
  if (!Number.isFinite(dailyPnL) || !Number.isFinite(dailyLossStop) || dailyLossStop <= 0) return false; // fail closed
  return dailyPnL > -dailyLossStop;
}

/** Clamp an order size to the agent's max clip. Never negative, never above the clip. */
export function clampClip(size: number, maxClip: number): number {
  if (!Number.isFinite(size) || !Number.isFinite(maxClip) || maxClip <= 0) return 0;
  return Math.min(Math.max(0, size), maxClip);
}
