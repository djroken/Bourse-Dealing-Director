import { z } from 'zod';

/**
 * Model adapters. A seat whose model id is `ollama:<name>` or `openrouter:<id>` asks that model for a view on the market.
 *
 * Safety rules that live here, not in the prompt:
 *  - Output is untrusted text. It is parsed against a strict schema; the model picks a side and a confidence and writes a
 *    short rationale. Core sizes the order, so a model can never choose a size, a symbol, or touch a limit.
 *  - Model seats are suggest-only: the engine never auto-fills on a model's say-so (see engine.ts).
 *  - Cost: Ollama is local. `openrouter:<id>` takes any OpenRouter model (the operator chooses, and may pay);
 *    `openrouter-free:<id>` only accepts `:free` ids. Each provider has a daily request cap you can raise or remove.
 */

export const ModelViewSchema = z.object({
  side: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});
export type ModelView = z.infer<typeof ModelViewSchema>;

export interface MarketContext {
  role: string;
  mandate: string;
  symbol: string;
  price: number;
  change24h: number | null;
}

export type ProviderName = 'ollama' | 'openrouter';

export interface ModelRef {
  provider: ProviderName;
  model: string;
  /** `openrouter-free:` seats refuse any model that isn't a `:free` variant. */
  freeOnly: boolean;
}

/** `ollama:llama3.2`, `openrouter:anthropic/claude-sonnet-4.5`, `openrouter-free:meta-llama/llama-3.3-70b-instruct:free`. Anything else is a stub-rule seat. */
export function parseModelRef(id: string): ModelRef | undefined {
  const m = /^(ollama|openrouter-free|openrouter):(.+)$/.exec(id.trim());
  if (!m) return undefined;
  const model = m[2]!.trim();
  if (!model) return undefined;
  return { provider: m[1] === 'ollama' ? 'ollama' : 'openrouter', model, freeOnly: m[1] === 'openrouter-free' };
}

/** OpenRouter bills anything that isn't a `:free` variant. */
export const isFreeOpenRouterModel = (model: string): boolean => /^[\w.\-/]+:free$/i.test(model);

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface AdvisorOptions {
  fetcher?: Fetcher;
  now?: () => number;
  ollamaHost?: string;
  /** Returns the OpenRouter key, read at call time so a key saved after boot works. */
  openrouterKey?: () => string | undefined;
  /** Max calls per provider per UTC day. 0 means unlimited (only meaningful for local Ollama). */
  dailyCap?: { ollama: number; openrouter: number };
  timeoutMs?: number;
}

/** What one model call cost. Tokens and latency always; USD only when the provider reports it (OpenRouter does). */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number | null;
}
export type AdvisorResult = { ok: true; view: ModelView; usage?: ModelUsage } | { ok: false; reason: string; usage?: ModelUsage };
export type ConverseResult = { ok: true; text: string; usage?: ModelUsage } | { ok: false; reason: string; usage?: ModelUsage };

export interface Advisor {
  /** Whether this model id would be handled by an adapter (even if it later fails). */
  handles(modelId: string): boolean;
  advise(modelId: string, ctx: MarketContext, temperature: number): Promise<AdvisorResult>;
  /** A free-form reply for the floor conversation. The caller parses and cleans it; nothing here trusts the text. */
  converse?(modelId: string, prompt: { system: string; user: string }, temperature: number, maxTokens?: number): Promise<ConverseResult>;
  status(): { ollama: { host: string; used: number; cap: number }; openrouter: { keySet: boolean; used: number; cap: number } };
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

/** Strip control characters and cap length: the rationale is shown to the operator and must not carry markup tricks. */
export function cleanRationale(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Pull the first JSON object out of a model reply (models like to wrap it in prose or fences) and validate it. */
export function parseModelView(text: string): ModelView | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.side === 'string') r.side = r.side.toUpperCase();
    if (typeof r.rationale === 'string') r.rationale = cleanRationale(r.rationale);
  }
  const parsed = ModelViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function buildPrompt(ctx: MarketContext): { system: string; user: string } {
  const change = ctx.change24h === null ? 'unknown' : `${ctx.change24h.toFixed(2)}%`;
  return {
    system:
      `You are the ${ctx.role} on a paper-trading desk. Your mandate: ${ctx.mandate.slice(0, 600)}\n` +
      'You only suggest; a human decides and software enforces limits. ' +
      'Reply with ONE JSON object and nothing else: {"side":"BUY"|"SELL"|"HOLD","confidence":0..1,"rationale":"one short sentence"}. ' +
      'Prefer HOLD when the evidence is thin.',
    user: `Symbol ${ctx.symbol}. Last price ${ctx.price}. 24h change ${change}. What is your view?`,
  };
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function createAdvisor(opts: AdvisorOptions = {}): Advisor {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const now = opts.now ?? Date.now;
  const ollamaHost = (opts.ollamaHost ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const cap = opts.dailyCap ?? { ollama: 0, openrouter: 200 }; // a runaway-loop guard, not a policy: raise it or set 0 for unlimited
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const usage: Record<ProviderName, { day: string; n: number }> = {
    ollama: { day: utcDay(now()), n: 0 },
    openrouter: { day: utcDay(now()), n: 0 },
  };

  const used = (p: ProviderName): number => {
    const u = usage[p];
    const today = utcDay(now());
    if (u.day !== today) {
      u.day = today;
      u.n = 0;
    }
    return u.n;
  };
  const overCap = (p: ProviderName): boolean => cap[p] > 0 && used(p) >= cap[p];

  async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) return { ok: false, reason: r.status === 429 ? 'rate limited (429)' : `HTTP ${r.status}` };
      return { ok: true, json: await r.json() };
    } catch (e) {
      return { ok: false, reason: ctl.signal.aborted ? 'timed out' : e instanceof Error ? e.message.slice(0, 80) : 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  const textOf = (json: unknown, provider: ProviderName): string => {
    const j = json as { message?: { content?: unknown }; choices?: Array<{ message?: { content?: unknown } }> };
    const c = provider === 'ollama' ? j?.message?.content : j?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c : '';
  };
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const usageOf = (json: unknown, provider: ProviderName, latencyMs: number): ModelUsage => {
    const j = (json ?? {}) as Record<string, unknown>;
    if (provider === 'ollama') return { promptTokens: n(j.prompt_eval_count), completionTokens: n(j.eval_count), latencyMs, costUsd: 0 };
    const u = (j.usage ?? {}) as Record<string, unknown>;
    return { promptTokens: n(u.prompt_tokens), completionTokens: n(u.completion_tokens), latencyMs, costUsd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null };
  };

  /** One chat completion. Every guard (free-only, key, daily cap) applies to every kind of call. */
  async function complete(modelId: string, messages: Array<{ role: string; content: string }>, temperature: number, maxTokens: number): Promise<{ ok: true; text: string; usage: ModelUsage } | { ok: false; reason: string; usage?: ModelUsage }> {
    const ref = parseModelRef(modelId);
    if (!ref) return { ok: false, reason: 'not a model seat' };
    const t0 = now();
    if (ref.provider === 'openrouter') {
      if (ref.freeOnly && !isFreeOpenRouterModel(ref.model)) return { ok: false, reason: 'OpenRouter free seats only take ":free" models' };
      const key = opts.openrouterKey?.();
      if (!key) return { ok: false, reason: 'no OpenRouter key saved in core' };
      if (overCap('openrouter')) return { ok: false, reason: `daily cap of ${cap.openrouter} OpenRouter calls reached` };
      usage.openrouter.n++; // count the attempt, not the success: a failing call still spends quota
      const res = await post('https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${key}` }, { model: ref.model, messages, temperature, max_tokens: maxTokens, usage: { include: true } });
      if (!res.ok) return res;
      return { ok: true, text: textOf(res.json, 'openrouter'), usage: usageOf(res.json, 'openrouter', now() - t0) };
    }
    if (overCap('ollama')) return { ok: false, reason: `daily cap of ${cap.ollama} Ollama calls reached` };
    usage.ollama.n++;
    const res = await post(`${ollamaHost}/api/chat`, {}, { model: ref.model, messages, stream: false, options: { temperature, num_predict: maxTokens } });
    if (!res.ok) return res;
    return { ok: true, text: textOf(res.json, 'ollama'), usage: usageOf(res.json, 'ollama', now() - t0) };
  }

  return {
    handles: (id) => parseModelRef(id) !== undefined,

    async advise(modelId, ctx, temperature) {
      const { system, user } = buildPrompt(ctx);
      const res = await complete(modelId, [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, 200);
      if (!res.ok) return res;
      const view = parseModelView(res.text);
      return view ? { ok: true, view, usage: res.usage } : { ok: false, reason: 'reply was not the expected JSON', usage: res.usage };
    },

    async converse(modelId, prompt, temperature, maxTokens = 240) {
      const res = await complete(modelId, [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], temperature, maxTokens);
      if (!res.ok) return res;
      return res.text.trim() ? { ok: true, text: res.text, usage: res.usage } : { ok: false, reason: 'empty reply', usage: res.usage };
    },

    status: () => ({
      ollama: { host: ollamaHost, used: used('ollama'), cap: cap.ollama },
      openrouter: { keySet: !!opts.openrouterKey?.(), used: used('openrouter'), cap: cap.openrouter },
    }),
  };
}
