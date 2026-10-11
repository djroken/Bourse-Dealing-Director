"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, type Mode, DEFAULT_SETUP, LIVE_AVAILABLE, LBL, PERP, SEED_AGENTS, SETUP_KEY, type Setup } from "./data";
import { fmt, fmtQty } from "./format";
import { VENUE_STEP, persistable } from "./onboarding";
import { fetchCloses, fetchEurUsd, fetchFundingRate, fetchQuotes } from "./market";
import {
  type DeskState, type Fill, type Filter, type MobileTab, type Tab,
  bookScale, createInitialState, makeFills, seqPx, tickState, venuesReady,
} from "./state";
import {
  DEFAULT_GLASS_ALPHA, GLASS_KEY, THEME_KEY, type ThemeName, pageBackground, themeVars,
} from "./theme";
import { buildView, resolveTheme } from "./view";

type Patch = Partial<DeskState> | ((s: DeskState) => Partial<DeskState> | null);

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: persistence is best-effort */
  }
}

/** Initial state + whatever the user persisted last session. Client-only (reads localStorage). */
function hydrate(base: DeskState): DeskState {
  let setup: Setup = base.setup;
  try {
    const saved = JSON.parse(readStorage(SETUP_KEY) || "null") as Partial<Setup> | null;
    if (saved) {
      setup = {
        ...DEFAULT_SETUP, ...saved,
        on: { ...DEFAULT_SETUP.on, ...(saved.on || {}) },
        vals: { ...(saved.vals || {}) },
        agentsOn: Array.isArray(saved.agentsOn) && saved.agentsOn.length === 8 ? saved.agentsOn : DEFAULT_SETUP.agentsOn.slice(),
      };
    }
  } catch {
    /* corrupt value: fall back to defaults */
  }
  const th = readStorage(THEME_KEY);
  const theme: ThemeName = th === "dark" || th === "light" || th === "system" || th === "glass" ? th : "dark";
  const ga = parseFloat(readStorage(GLASS_KEY) || "");
  const sysDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true;
  return {
    ...base, setup, theme, sysDark,
    setupNotice: !setup.done,
    glassAlpha: ga > 0 && ga <= 1 ? ga : DEFAULT_GLASS_ALPHA,
    vw: typeof window !== "undefined" ? window.innerWidth : base.vw,
  };
}

export interface DeskOptions {
  /** Simulation tick in ms (prototype default 2200). */
  tickMs?: number;
  /** Play the scripted floor conversation. Turn off once Hermes Core streams real events. */
  autoplay?: boolean;
}

export function useDesk({ tickMs = 2200, autoplay = true }: DeskOptions = {}) {
  const [s, setS] = useState<DeskState>(() => hydrate(createInitialState(Date.now())));
  const patch = useCallback((p: Patch) => {
    setS((prev) => {
      const d = typeof p === "function" ? p(prev) : p;
      return d ? { ...prev, ...d } : prev;
    });
  }, []);

  // ---- theme ---------------------------------------------------------------
  const appliedKeys = useRef<string[]>([]);
  const resolved = resolveTheme(s);
  useEffect(() => {
    const el = document.documentElement;
    appliedKeys.current.forEach((k) => el.style.removeProperty(k));
    const v = themeVars(resolved, s.glassAlpha);
    appliedKeys.current = Object.keys(v);
    for (const k of appliedKeys.current) el.style.setProperty(k, v[k]);
    el.style.colorScheme = resolved === "light" ? "light" : "dark";
    el.style.background = pageBackground(resolved);
  }, [resolved, s.glassAlpha]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => patch({ sysDark: e.matches });
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [patch]);

  useEffect(() => {
    const onResize = () => patch({ vw: window.innerWidth });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [patch]);

  // ---- persist setup (secrets stay in memory; see persistable) ----------------
  useEffect(() => {
    writeStorage(SETUP_KEY, JSON.stringify(persistable(s.setup)));
  }, [s.setup]);

  // ---- simulation tick -----------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => patch((st) => tickState(st, autoplay)), Math.max(600, tickMs));
    return () => clearInterval(id);
  }, [patch, tickMs, autoplay]);

  // ---- market data ---------------------------------------------------------
  const symRef = useRef(s.chartSym);
  useEffect(() => {
    symRef.current = s.chartSym;
  }, [s.chartSym]);
  const fundingAt = useRef(0);

  // Loaders are promise chains (not async bodies) so state only changes in callbacks, never synchronously in an effect.
  const loadFunding = useCallback(() => {
    fundingAt.current = Date.now();
    void fetchFundingRate(symRef.current).then((rate) => {
      if (rate !== null) patch({ funding: rate });
    });
  }, [patch]);

  const loadCloses = useCallback(() => {
    const sym = symRef.current;
    void fetchCloses(sym).then((closes) => {
      if (closes && closes.length > 2) patch((st) => ({ kl: { ...st.kl, [sym]: closes } }));
    });
  }, [patch]);

  const loadQuotes = useCallback(() => {
    void fetchQuotes().then((got) => {
      if (!got) {
        patch((st) => (st.gotLive ? null : { feed: "SIMULATED" }));
        return;
      }
      patch((st) => {
        const live = { ...st.live, ...got.quotes };
        const out: Partial<DeskState> = { live, feed: got.feed };
        if (!st.gotLive) {
          // First real print: re-base session marks and re-stamp the seeded fills/orders on real prices.
          const ref: Record<string, number> = {};
          for (const k of Object.keys(live)) ref[k] = live[k].px;
          out.ref = ref;
          out.gotLive = true;
          out.fills = makeFills(live, Date.now());
          out.seq = seqPx(st.seq, live);
        }
        return out;
      });
      if (Date.now() - fundingAt.current > 30000) loadFunding();
    });
  }, [patch, loadFunding]);

  useEffect(() => {
    loadQuotes();
    loadCloses();
    void fetchEurUsd().then((fx) => {
      if (fx !== null) patch({ fx });
    });
    const q = setInterval(loadQuotes, 5000);
    const k = setInterval(loadCloses, 60000);
    return () => {
      clearInterval(q);
      clearInterval(k);
    };
  }, [patch, loadQuotes, loadCloses]);

  // Tape click: new symbol → new candles + funding.
  const firstSym = useRef(true);
  useEffect(() => {
    if (firstSym.current) {
      firstSym.current = false;
      return;
    }
    loadCloses();
    loadFunding();
  }, [s.chartSym, loadCloses, loadFunding]);

  // ---- actions -------------------------------------------------------------
  const actions = useMemo(() => {
    const patchSel = (p: Partial<Agent>) =>
      patch((st) => ({ agents: st.agents.map((a, i) => (i === st.sel ? { ...a, ...p } : a)) }));

    return {
      setTheme: (name: ThemeName) => {
        writeStorage(THEME_KEY, name);
        patch({ theme: name });
      },
      setGlass: (pct: number) => {
        const a = pct / 100;
        writeStorage(GLASS_KEY, String(a));
        patch({ glassAlpha: a });
      },
      toggleCenter: () => patch((st) => ({ centerOpen: !st.centerOpen })),
      setTab: (tab: Tab) => patch({ tab }),
      setMTab: (mTab: MobileTab) => patch({ mTab }),
      openQueue: () => patch({ centerOpen: true, tab: "approvals", mTab: "approvals" }),
      setFilter: (filter: Filter) => patch({ filter }),
      selectAgent: (sel: number | null) => patch({ sel }),
      selectSym: (chartSym: string) => patch({ chartSym }),
      setChartSrc: (chartSrc: "tv" | "native") => patch({ chartSrc }),
      toggleHalt: () => patch((st) => ({ halted: !st.halted })),

      setDraft: (draft: string) => patch({ draft }),
      sendDraft: () =>
        patch((st) => {
          const v = st.draft.trim();
          if (!v) return null;
          const t = Date.now();
          return {
            draft: "",
            seq: st.seq.concat([
              { user: v, t },
              { reply: "Acknowledged. Routing that to the desk and I'll report back with sizing and the risk check.", t: t + 900 },
            ]).slice(-80),
          };
        }),

      setDemo: () => patch({ mode: "demo" as Mode }),
      // Every route to Live goes through LIVE_AVAILABLE, so while it is false the mode can never become "live".
      requestLive: () =>
        patch((st) => (st.mode === "live" ? null : LIVE_AVAILABLE ? { confirmLive: true } : { liveNotice: true })),
      toggleMode: () =>
        patch((st) =>
          st.mode === "live" ? { mode: "demo" as Mode } : LIVE_AVAILABLE ? { confirmLive: true } : { liveNotice: true },
        ),
      cancelLive: () => patch({ confirmLive: false }),
      closeLiveNotice: () => patch({ liveNotice: false }),
      confirmLiveGo: () =>
        patch((st) => {
          if (!LIVE_AVAILABLE) return { confirmLive: false, liveNotice: true };
          return venuesReady(st.setup).length
            ? { confirmLive: false, mode: "live" as Mode }
            : { confirmLive: false, setupNotice: true, onbStep: VENUE_STEP };
        }),
      openSetup: () => patch({ setupNotice: true, onbStep: 0 }),
      closeSetup: () => patch((st) => ({ setupNotice: false, setup: st.setup.done ? st.setup : { ...st.setup, done: true } })),
      setOnbStep: (onbStep: number) => patch({ onbStep }),
      updSetup: (fn: (su: Setup) => void) =>
        patch((st) => {
          const su: Setup = {
            ...st.setup, on: { ...st.setup.on }, vals: { ...st.setup.vals }, agentsOn: st.setup.agentsOn.slice(),
          };
          fn(su);
          return { setup: su };
        }),
      resetSetup: () =>
        patch({
          setup: { ...DEFAULT_SETUP, on: { ...DEFAULT_SETUP.on }, vals: {}, agentsOn: DEFAULT_SETUP.agentsOn.slice() },
          onbStep: 0,
        }),
      /** Finish onboarding. Live still goes through the confirm modal (and venue check). */
      launch: (live: boolean) =>
        patch((st) => ({
          setupNotice: false,
          setup: { ...st.setup, done: true },
          mode: "demo" as Mode,
          confirmLive: LIVE_AVAILABLE && live && venuesReady(st.setup).length > 0,
          liveNotice: !LIVE_AVAILABLE && live,
        })),

      patchSel,
      pauseSel: () =>
        patch((st) => ({ agents: st.agents.map((a, i) => (i === st.sel ? { ...a, paused: !a.paused } : a)) })),
      resetSel: () =>
        patch((st) => {
          if (st.sel === null) return null;
          const d = SEED_AGENTS[st.sel];
          return {
            agents: st.agents.map((a, i) =>
              i === st.sel
                ? { ...a, model: d.model, temp: d.temp, autonomy: d.autonomy, mandate: d.mandate, tools: d.tools.slice(), paused: false }
                : a,
            ),
          };
        }),

      setApprovalMult: (id: string, mult: number) =>
        patch((st) => ({ approvals: st.approvals.map((a) => (a.id === id ? { ...a, mult } : a)) })),
      decide: (id: string, ok: boolean) =>
        patch((st) => {
          const a = st.approvals.find((x) => x.id === id);
          if (!a) return null;
          const ag = st.agents[a.who];
          const now = Date.now();
          const px = st.live[a.k].px;
          const q = a.q * a.mult;
          const label = a.side + " " + PERP(a.k) + " " + fmtQty(q * bookScale(st.setup));
          const out: Partial<DeskState> = { approvals: st.approvals.filter((x) => x.id !== id) };
          const first = ag.name.split(" ")[0];
          if (ok) {
            const fill: Fill = { side: a.side, k: a.k, q, agent: ag.name, t: now, px, status: "FILLED" };
            out.fills = [fill].concat(st.fills).slice(0, 40);
            out.seq = st.seq.concat([{
              sysText: "YOU approved " + first + " · " + label + " filled @ " + fmt(px, LBL[a.k].dp) + (st.mode === "live" ? "" : " · paper"),
              t: now,
            }]).slice(-80);
          } else {
            out.seq = st.seq.concat([{ sysText: "YOU rejected " + first + " · " + label, t: now }]).slice(-80);
          }
          return out;
        }),
    };
  }, [patch]);

  const view = useMemo(() => buildView(s), [s]);
  return { s, view, actions };
}

export type DeskActions = ReturnType<typeof useDesk>["actions"];
