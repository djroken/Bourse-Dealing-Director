/**
 * What models a seat can actually be pointed at right now, for the Desk's model picker:
 * - OpenRouter's free models, from its public model list (no key needed to list them; one is needed to call them).
 * - The models installed in the local Ollama, if it is running.
 * Both lists are untrusted: ids are checked against a strict pattern and names are capped. Cached, so opening a
 * drawer doesn't hit OpenRouter every time.
 */

export interface CatalogModel {
  id: string;
  name: string;
  context: number | null;
}
export interface Catalog {
  openrouter: { keySet: boolean; free: CatalogModel[]; error: string | null; fetchedAt: number; budget: { used: number; cap: number } | null };
  ollama: { host: string; reachable: boolean; models: CatalogModel[] };
}

type GetJson = (url: string) => Promise<unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,79}$/;
const clean = (s: unknown, max = 60): string => (typeof s === 'string' ? s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max) : '');

/** OpenRouter's /models response → free models only (id ends in :free and prompt and completion are priced at 0). */
export function parseOpenRouterFree(body: unknown): CatalogModel[] {
  if (!isObj(body) || !Array.isArray(body.data)) return [];
  const out: CatalogModel[] = [];
  for (const m of body.data) {
    if (!isObj(m) || typeof m.id !== 'string' || !ID.test(m.id) || !m.id.endsWith(':free')) continue;
    const p = isObj(m.pricing) ? m.pricing : {};
    if (Number(p.prompt ?? 0) !== 0 || Number(p.completion ?? 0) !== 0) continue;
    const ctx = typeof m.context_length === 'number' && Number.isFinite(m.context_length) ? m.context_length : null;
    out.push({ id: `openrouter-free:${m.id}`, name: clean(m.name) || m.id, context: ctx });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
}

/** Ollama's /api/tags → installed models. */
export function parseOllamaTags(body: unknown): CatalogModel[] {
  if (!isObj(body) || !Array.isArray(body.models)) return [];
  return body.models
    .filter((m): m is Record<string, unknown> => isObj(m) && typeof m.name === 'string' && ID.test(m.name))
    .map((m) => ({ id: `ollama:${m.name as string}`, name: m.name as string, context: null }))
    .slice(0, 100);
}

export function createCatalog(opts: { getJson: GetJson; ollamaHost: string; openrouterKeySet: () => boolean; freeBudget?: () => { used: number; cap: number } | undefined; now?: () => number; ttlMs?: number }) {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60 * 60_000;
  let free: { list: CatalogModel[]; at: number; error: string | null } = { list: [], at: 0, error: null };
  let inflight: Promise<void> | null = null;
  let tried = false;
  const host = opts.ollamaHost.replace(/\/$/, '');

  const refreshFree = async (): Promise<void> => {
    tried = true;
    try {
      // The list may be paged (links.next); follow at most 10 pages, and only to openrouter.ai.
      let url: string | null = 'https://openrouter.ai/api/v1/models';
      const list: CatalogModel[] = [];
      for (let page = 0; url && page < 10; page++) {
        const body = await opts.getJson(url);
        list.push(...parseOpenRouterFree(body));
        const next = isObj(body) && isObj(body.links) && typeof body.links.next === 'string' ? body.links.next : null;
        url = next && /^https:\/\/openrouter\.ai\/api\/v1\/models/.test(next) ? next : null;
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      free = { list, at: now(), error: list.length ? null : 'OpenRouter listed no free models' };
    } catch (e) {
      // Keep the last good list; say why it's stale.
      free = { ...free, at: now(), error: e instanceof Error ? e.message.slice(0, 120) : 'unreachable' };
    }
  };

  return {
    async get(): Promise<Catalog> {
      if (!tried || now() - free.at > ttl || (free.error && now() - free.at > 60_000)) {
        inflight ??= refreshFree().finally(() => (inflight = null));
        await inflight;
      }
      let ollama: CatalogModel[] = [];
      let reachable = false;
      try {
        ollama = parseOllamaTags(await opts.getJson(`${host}/api/tags`));
        reachable = true;
      } catch {
        /* not running: that's fine */
      }
      return {
        openrouter: { keySet: opts.openrouterKeySet(), free: free.list, error: free.error, fetchedAt: free.at, budget: opts.freeBudget?.() ?? null },
        ollama: { host, reachable, models: ollama },
      };
    },
  };
}
