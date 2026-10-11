/**
 * Client for core's write-only secret store. Values go to core and are never read back: the only thing this module can
 * learn about a stored secret is that it exists.
 */

export const CORE_URL: string = (process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");

export type CoreSecretsState =
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "disabled" }
  | { kind: "ready"; ids: string[] };

type Fetch = typeof fetch;

export async function fetchSecretsState(f: Fetch = fetch, base: string = CORE_URL): Promise<CoreSecretsState> {
  try {
    const r = await f(`${base}/secrets`);
    if (!r.ok) return { kind: "unreachable" };
    const j = (await r.json()) as { enabled?: unknown; secrets?: unknown };
    if (j.enabled !== true) return { kind: "disabled" };
    const ids = Array.isArray(j.secrets)
      ? j.secrets.flatMap((x) => (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" ? [(x as { id: string }).id] : []))
      : [];
    return { kind: "ready", ids };
  } catch {
    return { kind: "unreachable" };
  }
}

/** Resolves to null on success, or a short human-readable error. */
export async function putSecret(id: string, value: string, f: Fetch = fetch, base: string = CORE_URL): Promise<string | null> {
  try {
    const r = await f(`${base}/secrets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return r.ok ? null : await errorText(r);
  } catch {
    return "Can't reach core";
  }
}

export async function deleteSecret(id: string, f: Fetch = fetch, base: string = CORE_URL): Promise<string | null> {
  try {
    const r = await f(`${base}/secrets/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok || r.status === 404 ? null : await errorText(r);
  } catch {
    return "Can't reach core";
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    /* fall through */
  }
  return `Core returned ${r.status}`;
}
