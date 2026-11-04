import type { Engine, FloorAgent, Logger } from './engine';
import { isFreeModelId } from './models';
import type { IdeaRecord } from './scorecard';

/**
 * Lessons: after a model seat's ideas are scored, the seat looks back at them and writes itself one short note
 * ("chased a 4% move on thin volume: wrong"). The notes go into its later prompts, so the agent carries forward why it
 * was right or wrong, not just that it was. This is the reflection loop of the floor.
 *
 * - Only real model seats reflect, only on their own ideas, never on ideas the stub rule made after a failed call.
 * - Rationed: at most one reflection per seat every `minGapMs` (several scored ideas are reviewed together), and free
 *   models only reflect while plenty of the free allowance is left.
 * - A lesson is the model's own text: cleaned, capped, and shown back to it labelled as its own notes, context and
 *   never instructions.
 */

export interface Lesson {
  agentId: string;
  role: string;
  name: string;
  model: string;
  text: string;
  /** The ideas it looked back on, and how many of them were right. */
  ideas: string[];
  right: number;
  of: number;
  ts: number;
}

export interface LessonsOptions {
  engine: Engine;
  now?: () => number;
  log?: Logger;
  /** Least time between two reflections by the same seat. Default 20 minutes. */
  minGapMs?: number;
  /** Free-model calls that must be left before a free seat reflects. Default 20. */
  freeFloor?: number;
  /** Lessons read back from disk. Untrusted: checked one by one. */
  initial?: unknown;
  /** Called after each new lesson with every lesson kept, to save them. */
  onSave?: (all: Lesson[]) => void;
  /** Called with the record of each reflection call (prompt and reply), for the training log. */
  onCall?: (rec: { agentId: string; role: string; name: string; model: string; system: string; user: string; ok: boolean; reply: string | null; error: string | null; lesson: string | null; at: number }) => void;
}

const KEEP_PER_SEAT = 5;
// eslint-disable-next-line no-control-regex
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** A reflection reply: `{"lesson": "..."}`, or plain text. Null when there's nothing usable. */
export function parseLesson(text: string): string | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
      if (typeof j.lesson === 'string') return clean(j.lesson, 200) || null;
    } catch {
      /* fall through */
    }
  }
  const plain = clean(text.replace(/```[\s\S]*?```/g, ' ').replace(/[{}"]/g, ' '), 200);
  return plain.length >= 8 ? plain : null;
}

export function parseLessons(raw: unknown): Lesson[] {
  if (!Array.isArray(raw)) return [];
  const out: Lesson[] = [];
  for (const r of raw.slice(-200)) {
    if (typeof r !== 'object' || r === null) continue;
    const x = r as Record<string, unknown>;
    const str = (v: unknown, n: number) => (typeof v === 'string' ? clean(v, n) : '');
    const text = str(x.text, 200);
    if (!str(x.agentId, 32) || !text || typeof x.ts !== 'number' || !Number.isFinite(x.ts)) continue;
    out.push({
      agentId: str(x.agentId, 32), role: str(x.role, 64), name: str(x.name, 64), model: str(x.model, 96), text,
      ideas: Array.isArray(x.ideas) ? x.ideas.filter((i): i is string => typeof i === 'string').slice(0, 5).map((i) => i.slice(0, 40)) : [],
      right: typeof x.right === 'number' ? x.right : 0, of: typeof x.of === 'number' ? x.of : 0, ts: x.ts,
    });
  }
  return out;
}

export function createLessons(opts: LessonsOptions) {
  const { engine } = opts;
  const now = opts.now ?? Date.now;
  const log: Logger = opts.log ?? { info: () => {}, warn: () => {} };
  const minGap = opts.minGapMs ?? 20 * 60_000;
  const freeFloor = opts.freeFloor ?? 20;
  const all: Lesson[] = parseLessons(opts.initial);
  const pending = new Map<string, IdeaRecord[]>();
  const lastAt = new Map<string, number>();
  const busy = new Set<string>();

  const seatOf = (id: string): FloorAgent | undefined => engine.agents.find((a) => a.id === id && !a.external);
  const canReflect = (a: FloorAgent) => !!engine.advisor?.handles(a.config.model) && !!engine.advisor.converse;

  /** The seat's latest notes, oldest first: what goes into its prompts. */
  const notesFor = (agentId: string): string[] => all.filter((l) => l.agentId === agentId).slice(-3).map((l) => l.text);

  const fmt = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p < 10 ? 4 : 2 });
  const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

  async function reflect(a: FloorAgent): Promise<Lesson | null> {
    const recs = (pending.get(a.id) ?? []).slice(-3);
    pending.delete(a.id);
    if (!recs.length) return null;
    busy.add(a.id);
    lastAt.set(a.id, now());
    const right = recs.filter((r) => r.outcome!.correct).length;
    const system =
      `You are ${a.config.name}, the ${a.config.role} on Bourse, a paper-trading desk run by AI agents. ` +
      'Look back at your own ideas below, now that the market has scored them, and write yourself ONE short lesson for next time: what you got right or wrong and why, in plain words, at most 25 words. ' +
      'Be honest; a lucky win is not a good call. Reply with ONE JSON object and nothing else: {"lesson": "..."}.';
    const user = [
      `Your ideas, scored ${Math.round(engine.scoreHorizonMs / 60_000)} minutes after you made them:`,
      ...recs.map((r) => {
        const o = r.outcome!;
        return `- ${hhmm(r.ts)} ${r.side} ${r.symbol} @ ${fmt(r.price)}, confidence ${Math.round(r.confidence * 100)}%, because: "${clean(r.rationale, 160).replace(/"/g, "'")}". ` +
          `Then ${fmt(o.exitPrice)}: ${o.returnPct >= 0 ? '+' : ''}${o.returnPct.toFixed(2)}% in your direction (${o.correct ? 'right' : 'wrong'}).`;
      }),
      notesFor(a.id).length ? `Your earlier notes (your own words): ${notesFor(a.id).map((n) => `"${n.replace(/"/g, "'")}"`).join(' ')}` : '',
    ].filter(Boolean).join('\n');
    const model = a.config.model;
    try {
      const res = await engine.advisor!.converse!(model, { system, user }, Math.min(a.config.temperature, 0.4), 120).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'failed', usage: undefined }));
      engine.recordUsage(a, res.usage, res.ok ? undefined : res.reason);
      const text = res.ok ? parseLesson(res.text) : null;
      opts.onCall?.({ agentId: a.id, role: a.config.role, name: a.config.name, model, system, user, ok: res.ok && !!text, reply: res.ok ? res.text.slice(0, 2000) : null, error: res.ok ? (text ? null : 'no lesson in the reply') : res.reason, lesson: text, at: now() });
      if (!text) {
        if (!res.ok) log.warn(`lesson: ${model} unavailable for ${a.config.role}: ${res.reason}`);
        return null;
      }
      const lesson: Lesson = { agentId: a.id, role: a.config.role, name: a.config.name, model, text, ideas: recs.map((r) => r.id), right, of: recs.length, ts: now() };
      all.push(lesson);
      // Keep the latest few per seat.
      const mine = all.filter((l) => l.agentId === a.id);
      if (mine.length > KEEP_PER_SEAT) all.splice(all.indexOf(mine[0]!), 1);
      engine.speak({ id: a.id, role: a.config.role, name: a.config.name }, `Lesson (${right} of ${recs.length} right): ${text}`, { model, lesson: true });
      opts.onSave?.([...all]);
      return lesson;
    } finally {
      busy.delete(a.id);
    }
  }

  /** Reflect for every seat that has scored ideas waiting and is allowed to now. */
  async function step(): Promise<Lesson[]> {
    const out: Lesson[] = [];
    for (const [id] of pending) {
      const a = seatOf(id);
      if (!a || a.state !== 'running' || !canReflect(a) || busy.has(id)) {
        if (!a || !canReflect(a)) pending.delete(id);
        continue;
      }
      if (now() - (lastAt.get(id) ?? -Infinity) < minGap) continue;
      if (isFreeModelId(a.config.model) && (engine.advisor?.freeLeft?.() ?? Infinity) <= freeFloor) continue;
      const l = await reflect(a);
      if (l) out.push(l);
    }
    return out;
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    /** Feed every scored idea here. Only the seat's own model ideas are kept for reflection. */
    onResolved(rec: IdeaRecord): void {
      if (!rec.outcome || rec.expired || rec.fallback) return;
      const a = seatOf(rec.agentId);
      if (!a || !canReflect(a) || a.config.model !== rec.model) return;
      const list = pending.get(a.id) ?? [];
      list.push(rec);
      pending.set(a.id, list.slice(-10));
    },
    step,
    notesFor,
    all: () => [...all],
    start(everyMs = 60_000): void {
      if (timer) return;
      timer = setInterval(() => void step(), everyMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Lessons = ReturnType<typeof createLessons>;
