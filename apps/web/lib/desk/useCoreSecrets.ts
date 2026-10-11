"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteSecret, fetchSecretsState, putSecret, type CoreSecretsState } from "./secrets";

export interface CoreSecrets {
  state: CoreSecretsState;
  has: (id: string) => boolean;
  busy: string | null;
  error: string | null;
  save: (id: string, value: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  recheck: () => void;
}

export function useCoreSecrets(): CoreSecrets {
  const [state, setState] = useState<CoreSecretsState>({ kind: "checking" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(() => {
    void fetchSecretsState().then(setState);
  }, []);
  useEffect(() => {
    recheck();
  }, [recheck]);

  const has = useCallback((id: string) => state.kind === "ready" && state.ids.includes(id), [state]);

  const save = useCallback(async (id: string, value: string) => {
    setBusy(id);
    setError(null);
    const err = await putSecret(id, value);
    setBusy(null);
    if (err) {
      setError(err);
      return false;
    }
    setState((s) => (s.kind === "ready" ? { kind: "ready", ids: [...new Set([...s.ids, id])] } : s));
    return true;
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    const err = await deleteSecret(id);
    setBusy(null);
    if (err) setError(err);
    else setState((s) => (s.kind === "ready" ? { kind: "ready", ids: s.ids.filter((x) => x !== id) } : s));
  }, []);

  return { state, has, busy, error, save, remove, recheck };
}
