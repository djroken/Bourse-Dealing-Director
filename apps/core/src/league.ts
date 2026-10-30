import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { IdeaRecord } from './scorecard';

/**
 * The model league: every scored idea, grouped by the model that had it, across sessions. Reads the idea log
 * (ideas.jsonl, written as ideas are scored) plus this session's ideas that aren't in it yet, so it answers "which
 * model trades best on this floor?" with every idea ever scored, not just today's.
 *
 * Seats without a real model are pooled as "stub rule" so the baseline is one row, whatever label the seat had.
 */

export interface LeagueRow {
  model: string;
  /** Scored ideas (expired ones don't count). */
  ideas: number;
  hits: number;
  hitRate: number;
  /** Mean move in the ideas' direction at the horizon, percent. */
  avgReturnPct: number;
  /** Seats (roles) that used this model. */
  seats: string[];
  firstAt: number;
  lastAt: number;
}

export interface League {
  rows: LeagueRow[];
  scored: number;
  /** Lines in the log that couldn't be read (skipped). */
  skipped: number;
  /** Where the history came from. */
  source: 'log+session' | 'session';
  computedAt: number;
}

const MODEL = /^(ollama|openrouter-free|openrouter):/;
export const leagueKey = (model: string): string => (MODEL.test(model) ? model : model === 'external agent (MCP)' ? 'guest agents (MCP)' : 'stub rule');

type Scored = Pick<IdeaRecord, 'id' | 'model' | 'role' | 'ts' | 'fallback' | 'rationale'> & { outcome: { returnPct: number; correct: boolean } };
/** A model's failed call fell back to the stub rule: credit the baseline, not the model. Older logs lack the flag. */
const keyOf = (r: Scored): string => (r.fallback || / unavailable \(.*\); stub momentum rule instead$/.test(r.rationale ?? '') ? 'stub rule' : leagueKey(r.model));

const isScored = (r: unknown): r is Scored => {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  const o = x.outcome as Record<string, unknown> | null | undefined;
  return typeof x.id === 'string' && typeof x.model === 'string' && typeof x.role === 'string' && typeof x.ts === 'number' &&
    !!o && typeof o.returnPct === 'number' && Number.isFinite(o.returnPct) && typeof o.correct === 'boolean' && x.expired !== true;
};

export function tally(records: Iterable<Scored>, minIdeas = 1): LeagueRow[] {
  const by = new Map<string, { ideas: number; hits: number; ret: number; seats: Set<string>; first: number; last: number }>();
  for (const r of records) {
    const k = keyOf(r);
    const g = by.get(k) ?? { ideas: 0, hits: 0, ret: 0, seats: new Set<string>(), first: r.ts, last: r.ts };
    g.ideas += 1;
    if (r.outcome.correct) g.hits += 1;
    g.ret += r.outcome.returnPct;
    g.seats.add(r.role);
    g.first = Math.min(g.first, r.ts);
    g.last = Math.max(g.last, r.ts);
    by.set(k, g);
  }
  return [...by.entries()]
    .filter(([, g]) => g.ideas >= minIdeas)
    .map(([model, g]) => ({
      model, ideas: g.ideas, hits: g.hits, hitRate: g.hits / g.ideas, avgReturnPct: g.ret / g.ideas,
      seats: [...g.seats].sort().slice(0, 12), firstAt: g.first, lastAt: g.last,
    }))
    // Best average return first; the hit rate breaks ties. Small samples are shown, and labelled by their count.
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct || b.hitRate - a.hitRate || b.ideas - a.ideas);
}

export function createLeague(opts: { file: string | null; session: () => IdeaRecord[]; now?: () => number; cacheMs?: number }) {
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 30_000;
  let cached: League | null = null;
  let inflight: Promise<League> | null = null;

  async function compute(): Promise<League> {
    const seen = new Set<string>();
    const all: Scored[] = [];
    let skipped = 0;
    const useLog = !!opts.file && existsSync(opts.file);
    if (useLog) {
      const rl = createInterface({ input: createReadStream(opts.file!, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const r: unknown = JSON.parse(line);
          if (isScored(r) && !seen.has(r.id)) {
            seen.add(r.id);
            all.push(r);
          } else if (!isScored(r)) skipped++;
        } catch {
          skipped++;
        }
      }
    }
    for (const r of opts.session()) if (isScored(r) && !seen.has(r.id)) all.push(r);
    return { rows: tally(all), scored: all.length, skipped, source: useLog ? 'log+session' : 'session', computedAt: now() };
  }

  return {
    async get(): Promise<League> {
      if (cached && now() - cached.computedAt < cacheMs) return cached;
      inflight ??= compute().finally(() => (inflight = null));
      cached = await inflight;
      return cached;
    },
  };
}
