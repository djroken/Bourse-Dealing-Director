import { CORE_URL } from "./secrets";

/**
 * Core's model catalog (GET /models/catalog): OpenRouter's free models, what's installed in Ollama, and whether core
 * has the OpenRouter key. Untrusted input, checked field by field.
 */

export interface PickModel {
  id: string;
  name: string;
}
export interface ModelCatalog {
  /** Model seats on AUTO trade their own ideas on the paper venue. */
  modelAuto: boolean;
  openrouterKey: boolean;
  /** Free-model calls today across all seats, and the daily budget (0 = no limit). */
  freeBudget: { used: number; cap: number } | null;
  free: PickModel[];
  freeError: string | null;
  ollama: PickModel[];
  ollamaUp: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^(ollama|openrouter-free|openrouter):[A-Za-z0-9][A-Za-z0-9._\-/:]{0,79}$/;
const list = (v: unknown, prefix: string, max: number): PickModel[] =>
  Array.isArray(v)
    ? v
        .filter((m): m is Record<string, unknown> => isObj(m) && typeof m.id === "string" && ID.test(m.id) && m.id.startsWith(prefix))
        .slice(0, max)
        .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name.replace(/[^\x20-\x7e]/g, "").slice(0, 60) || (m.id as string) : (m.id as string) }))
    : [];

export function parseCatalog(raw: unknown): ModelCatalog | null {
  if (!isObj(raw) || !isObj(raw.openrouter) || !isObj(raw.ollama)) return null;
  const o = raw.openrouter;
  const l = raw.ollama;
  const b = isObj(o.budget) && typeof o.budget.used === "number" && typeof o.budget.cap === "number" && o.budget.used >= 0 && o.budget.cap >= 0 ? { used: o.budget.used, cap: o.budget.cap } : null;
  return {
    modelAuto: raw.modelAuto === true,
    openrouterKey: o.keySet === true,
    freeBudget: b,
    free: list(o.free, "openrouter-free:", 200),
    freeError: typeof o.error === "string" ? o.error.slice(0, 120) : null,
    ollama: list(l.models, "ollama:", 100),
    ollamaUp: l.reachable === true,
  };
}

export async function fetchCatalog(f: typeof fetch = fetch, base: string = CORE_URL): Promise<ModelCatalog | null> {
  try {
    const r = await f(`${base}/models/catalog`);
    return r.ok ? parseCatalog(await r.json()) : null;
  } catch {
    return null;
  }
}

/** A custom id the drawer will accept: a provider prefix and a plausible model id. */
export const customModelOk = (id: string): boolean => ID.test(id.trim());

/** The line under the picker that says whether OpenRouter models can actually run. */
export function keyLine(cat: ModelCatalog | null, model: string): { text: string; ok: boolean } | null {
  if (!cat) return null;
  if (model.startsWith("openrouter")) {
    const b = cat.freeBudget;
    const budget = model.endsWith(":free") && b && b.cap > 0
      ? ` Free calls today: ${b.used} of ${b.cap}, shared by every free seat (OpenRouter allows 50 a day without credits). Free seats talk in floor rounds only.`
      : "";
    if (cat.openrouterKey && b && b.cap > 0 && b.used >= b.cap && model.endsWith(":free")) {
      return { ok: false, text: `Today's free-model calls are used up (${b.used} of ${b.cap}). They reset at 00:00 UTC.` };
    }
    return cat.openrouterKey
      ? { ok: true, text: "OpenRouter key: found in core." + budget }
      : { ok: false, text: "OpenRouter key: core doesn't have it, so this seat can't call the model. Save it in Setup (step 02, SAVE TO CORE), or add OPENROUTER_API_KEY=sk-or-… to a file called .env in the Bourse folder and restart pnpm dev." };
  }
  if (model.startsWith("ollama:")) {
    return cat.ollamaUp ? { ok: true, text: "Ollama: running on this machine." } : { ok: false, text: "Ollama isn't running on this machine, so this seat can't call the model." };
  }
  return null;
}

/** Turn "model seats on AUTO trade on paper by themselves" on or off in core. Returns the new value, or null. */
export async function setModelAuto(on: boolean, f: typeof fetch = fetch, base: string = CORE_URL): Promise<boolean | null> {
  try {
    const r = await f(`${base}/floor/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelAuto: on }) });
    const j: unknown = r.ok ? await r.json() : null;
    return isObj(j) && typeof j.modelAuto === "boolean" ? j.modelAuto : null;
  } catch {
    return null;
  }
}

/** What AUTO means for this seat, said plainly under the autonomy buttons. Null when there's nothing to add. */
export function autoNote(cat: ModelCatalog | null, model: string, autonomy: string): { text: string; on: boolean } | null {
  if (!cat || autonomy !== "AUTO" || !/^(ollama|openrouter|openrouter-free):/.test(model)) return null;
  return cat.modelAuto
    ? { on: true, text: "On AUTO this seat trades its own ideas on the paper book, after the risk gate. Play money only: never a broker, never live." }
    : { on: false, text: "Model seats only suggest until you let them trade: each idea waits in your queue. Allow it to let AUTO model seats paper-trade by themselves (for every model seat)." };
}
