import { describe, expect, it, vi } from "vitest";
import { deleteSecret, fetchSecretsState, putSecret } from "../lib/desk/secrets";

const res = (status: number, json: unknown) => Promise.resolve(new Response(JSON.stringify(json), { status }));

describe("core secrets client", () => {
  it("reports ready with the ids that exist, and nothing else", async () => {
    const f = vi.fn(() => res(200, { enabled: true, secrets: [{ id: "a.key", updatedAt: 1, value: "LEAK" }, { nope: 1 }] }));
    expect(await fetchSecretsState(f as never, "http://c")).toEqual({ kind: "ready", ids: ["a.key"] });
  });
  it("distinguishes disabled from unreachable", async () => {
    expect(await fetchSecretsState((() => res(200, { enabled: false, secrets: [] })) as never, "http://c")).toEqual({ kind: "disabled" });
    expect(await fetchSecretsState((() => res(500, {})) as never, "http://c")).toEqual({ kind: "unreachable" });
    expect(await fetchSecretsState((() => Promise.reject(new Error("refused"))) as never, "http://c")).toEqual({ kind: "unreachable" });
  });
  it("PUTs JSON to an encoded id and surfaces core's error text", async () => {
    const f = vi.fn((...args: [string, RequestInit?]) => (args.length ? res(200, { ok: true }) : res(200, {})));
    expect(await putSecret("model.open ai.key", "v", f as never, "http://c")).toBeNull();
    expect(f.mock.calls[0]![0]).toBe("http://c/secrets/model.open%20ai.key");
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: JSON.stringify({ value: "v" }) });
    expect(await putSecret("x", "v", (() => res(503, { error: "secret store disabled" })) as never, "http://c")).toBe("secret store disabled");
    expect(await putSecret("x", "v", (() => Promise.reject(new Error("down"))) as never, "http://c")).toBe("Can't reach core");
  });
  it("treats deleting something already gone as success", async () => {
    expect(await deleteSecret("x", (() => res(404, { error: "not found" })) as never, "http://c")).toBeNull();
    expect(await deleteSecret("x", (() => res(500, {})) as never, "http://c")).toBe("Core returned 500");
  });
});
