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
  openrouterKey: boolean;
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
  return {
    openrouterKey: o.keySet === true,
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
    return cat.openrouterKey
      ? { ok: true, text: "OpenRouter key: found in core." }
      : { ok: false, text: "OpenRouter key: core doesn't have it, so this seat can't call the model. Add OPENROUTER_API_KEY=sk-or-… to a file called .env in the Bourse folder and restart pnpm dev (or save it in Setup, which needs BOURSE_MASTER_KEY)." };
  }
  if (model.startsWith("ollama:")) {
    return cat.ollamaUp ? { ok: true, text: "Ollama: running on this machine." } : { ok: false, text: "Ollama isn't running on this machine, so this seat can't call the model." };
  }
  return null;
}
