import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { FloorSnapshot } from './engine';

/**
 * Paper state on disk: <dataDir>/state.json. Written atomically (temp file + rename), mode 600.
 * A file that fails validation is moved aside, never half-loaded: a fresh floor is better than a corrupt one.
 */

const fin = z.number().finite();
const IdeaSchema = z.object({
  id: z.string().max(64), ts: fin, agentId: z.string().max(64), role: z.string().max(64), name: z.string().max(64), model: z.string().max(96),
  temperature: fin, autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']), symbol: z.string().max(32), side: z.enum(['BUY', 'SELL']),
  size: fin, confidence: fin, rationale: z.string().max(4000), price: fin, change24h: fin.nullable(), source: z.string().max(32),
  filled: z.boolean(),
  outcome: z.object({ horizonMs: fin, exitPrice: fin, returnPct: fin, correct: z.boolean() }).nullable(),
  expired: z.boolean().optional(),
});
const CardSchema = z.object({
  agentId: z.string().max(64), role: z.string().max(64), name: z.string().max(64), model: z.string().max(96),
  ideas: fin, holds: fin, scored: fin, hits: fin, hitRate: fin.nullable(), avgReturnPct: fin.nullable(), fills: fin, vetoes: fin,
  notional: fin, closes: fin, wins: fin, winRate: fin.nullable(), realized: fin, pnl: fin, peakPnl: fin, maxDrawdown: fin, updatedAt: fin,
});
export const SnapshotSchema = z.object({
  v: z.literal(1),
  savedAt: fin,
  seats: z.array(z.object({ role: z.string().max(64), model: z.string().min(1).max(96), temperature: z.number().min(0).max(2), autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']), mandate: z.string().max(2000), paused: z.boolean() })).max(64),
  guests: z.array(z.string().max(64)).max(8),
  books: z.array(z.object({ role: z.string().max(64), realized: fin, positions: z.array(z.object({ symbol: z.string().max(32), qty: fin, avg: fin })).max(32), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dayStartPnl: fin.optional() })).max(64),
  ids: z.record(z.string().max(64), z.string().max(64)),
  scores: z.object({ cards: z.array(CardSchema).max(64), returnSum: z.record(z.string().max(64), fin), ideas: z.array(IdeaSchema).max(5000) }),
});

export type LoadResult = { kind: 'none' } | { kind: 'ok'; snap: FloorSnapshot } | { kind: 'bad'; reason: string; movedTo: string };

export function loadSnapshot(file: string, now: () => number = Date.now): LoadResult {
  if (!existsSync(file)) return { kind: 'none' };
  let reason: string;
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return { kind: 'ok', snap: parsed.data as FloorSnapshot };
    reason = parsed.error.issues[0] ? `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` : 'invalid';
  } catch (err) {
    reason = err instanceof Error ? err.message : 'unreadable';
  }
  const movedTo = `${file}.bad-${now()}`;
  renameSync(file, movedTo);
  return { kind: 'bad', reason, movedTo };
}

export function saveSnapshot(file: string, snap: FloorSnapshot): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on every platform */
  }
}
