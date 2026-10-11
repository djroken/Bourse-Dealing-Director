/**
 * A paper book: signed positions per symbol with average-cost accounting. Pure and tiny so it is easy to check by hand.
 * Quantities are asset units (negative = short); prices and P&L are USD.
 */

export interface Position {
  qty: number;
  avg: number;
}
export interface Book {
  positions: Map<string, Position>;
  realized: number;
}
export interface BookView {
  pnl: number;
  exposure: number;
  positions: Array<{ symbol: string; qty: number; avgPx: number }>;
}

export const newBook = (): Book => ({ positions: new Map(), realized: 0 });

const EPS = 1e-9;

export function applyFill(book: Book, symbol: string, side: 'BUY' | 'SELL', units: number, px: number): void {
  if (!(units > 0) || !Number.isFinite(units) || !(px > 0) || !Number.isFinite(px)) return;
  const signed = side === 'BUY' ? units : -units;
  const pos = book.positions.get(symbol) ?? { qty: 0, avg: 0 };

  if (Math.abs(pos.qty) < EPS || Math.sign(pos.qty) === Math.sign(signed)) {
    const total = Math.abs(pos.qty) + units;
    pos.avg = (Math.abs(pos.qty) * pos.avg + units * px) / total;
    pos.qty += signed;
  } else {
    const closing = Math.min(units, Math.abs(pos.qty));
    book.realized += closing * (px - pos.avg) * Math.sign(pos.qty);
    pos.qty += signed;
    if (Math.abs(pos.qty) < EPS) {
      pos.qty = 0;
      pos.avg = 0;
    } else if (Math.sign(pos.qty) === Math.sign(signed)) {
      pos.avg = px; // flipped through zero: the remainder opened at this price
    }
  }
  if (pos.qty === 0) book.positions.delete(symbol);
  else book.positions.set(symbol, pos);
}

/** Mark to the latest prices. A symbol with no price yet is carried at its average (zero unrealised). */
export function mark(book: Book, last: ReadonlyMap<string, number>): BookView {
  let unrealised = 0;
  let exposure = 0;
  const positions: BookView['positions'] = [];
  for (const [symbol, p] of book.positions) {
    const px = last.get(symbol) ?? p.avg;
    unrealised += p.qty * (px - p.avg);
    exposure += Math.abs(p.qty) * px;
    positions.push({ symbol, qty: p.qty, avgPx: p.avg });
  }
  return { pnl: book.realized + unrealised, exposure, positions };
}
