import { CORE_URL } from "./secrets";

/** Core's lessons (GET /lessons): notes each model seat wrote itself after its ideas were scored. Untrusted, checked. */
export interface LessonRow {
  agentId: string; role: string; text: string; right: number; of: number; ts: number; model: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseLessons(raw: unknown): LessonRow[] {
  if (!isObj(raw) || !Array.isArray(raw.lessons)) return [];
  return raw.lessons
    .filter((l): l is Record<string, unknown> => isObj(l) && typeof l.agentId === "string" && typeof l.text === "string" && l.text.length <= 200 && typeof l.ts === "number")
    .map((l) => ({
      agentId: l.agentId as string, role: typeof l.role === "string" ? l.role.slice(0, 64) : "", text: l.text as string, ts: l.ts as number,
      right: typeof l.right === "number" ? l.right : 0, of: typeof l.of === "number" ? l.of : 0,
      model: typeof l.model === "string" ? l.model.slice(0, 96) : "",
    }))
    .slice(-200);
}

export async function fetchLessons(f: typeof fetch = fetch, base: string = CORE_URL): Promise<LessonRow[] | null> {
  try {
    const r = await f(`${base}/lessons`);
    return r.ok ? parseLessons(await r.json()) : null;
  } catch {
    return null;
  }
}

/** A seat's lessons, newest first, ready to show. */
export function lessonLines(all: LessonRow[] | null, role: string): Array<{ key: string; when: string; text: string; score: string }> {
  return (all ?? [])
    .filter((l) => l.role.toUpperCase() === role.toUpperCase())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((l) => ({ key: String(l.ts) + l.text.slice(0, 8), when: new Date(l.ts).toISOString().slice(5, 16).replace("T", " "), text: l.text, score: l.of ? `${l.right} of ${l.of} right` : "" }));
}
