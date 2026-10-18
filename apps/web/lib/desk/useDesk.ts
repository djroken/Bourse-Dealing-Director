"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, type Mode, DEFAULT_SETUP, LIVE_AVAILABLE, LBL, PERP, SEED_AGENTS, SETUP_KEY, type Setup } from "./data";
import { fmt, fmtQty } from "./format";
import { applyCoreMsg, coreFloorUrl, onCoreConnected, onCoreLost, parseCoreMsg, seatOf } from "./core";
import { VENUE_STEP, persistable } from "./onboarding";
import { fetchCandles, fetchEurUsd, fetchFundingRate, fetchQuotes, type Timeframe } from "./market";
import { fetchSignals } from "./signals";
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
  /** Play the scripted floor conversation. Turn off once Bourse Core streams real events. */
  autoplay?: boolean;
  /** Connect to Bourse Core's agent stream (default on). */
  core?: boolean;
}

export function useDesk({ tickMs = 2200, autoplay = true, core: coreEnabled = true }: DeskOptions = {}) {
  const [s, setS] = useState<DeskState>(() => hydrate(createInitialState(Date.now())));
  const patch = useCallback((p: Patch) => {
    setS((prev) => {
      const d = typeof p === "function" ? p(prev) : p;
      return d ? { ...prev, ...d } : prev;
    });
  }, []);

  // Latest state for event handlers that must talk to the socket: side effects never go inside a state updater,
  // because React may run an updater twice (StrictMode), and an order must be sent exactly once.
  const stateRef = useRef(s);
  useEffect(() => {
    stateRef.current = s;
  }, [s]);

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

  // ---- Bourse Core floor stream ---------------------------------------------
  // While connected, core's agents drive the floor and the scripted simulation pauses. If core isn't there (or goes
  // away) the desk stays on the simulated floor and keeps retrying quietly.
  const coreWs = useRef<WebSocket | null>(null);
  // Drawer edits wait a moment (so typing a mandate isn't one message per keystroke), then go to core as one change per seat.
  // While a seat has an unsent edit, core's echo of an older value for that seat is ignored so it can't overwrite what you're typing.
  type CfgPatch = { autonomy?: string; paused?: boolean; model?: string; temperature?: number; mandate?: string };
  const cfgPending = useRef(new Map<number, CfgPatch>());
  const cfgTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushCfg = useCallback(() => {
    clearTimeout(cfgTimer.current);
    const ws = coreWs.current;
    const st = stateRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const [i, fields] of cfgPending.current) {
        const ag = st.agents[i];
        if (ag) ws.send(JSON.stringify({ type: "configure_agent", role: ag.role, ...fields }));
      }
    }
    cfgPending.current.clear();
  }, []);
  const queueCfg = useCallback(
    (i: number, fields: CfgPatch, now = false) => {
      cfgPending.current.set(i, { ...(cfgPending.current.get(i) ?? {}), ...fields });
      clearTimeout(cfgTimer.current);
      if (now) flushCfg();
      else cfgTimer.current = setTimeout(flushCfg, 350);
    },
    [flushCfg],
  );
  useEffect(() => {
    if (!coreEnabled || typeof WebSocket === "undefined") return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    const connect = () => {
      if (stopped) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(coreFloorUrl());
      } catch {
        patch({ core: "offline" });
        return;
      }
      coreWs.current = ws;
      ws.onopen = () => {
        delay = 2000;
        patch((st) => onCoreConnected(st, Date.now()));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = parseCoreMsg(JSON.parse(String(ev.data)));
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.type === "config" && cfgPending.current.has(seatOf(stateRef.current, msg.role))) return;
        patch((st) => applyCoreMsg(st, msg));
      };
      ws.onclose = () => {
        if (coreWs.current === ws) coreWs.current = null;
        if (stopped) return;
        patch((st) => onCoreLost(st, Date.now(), st.core));
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 20000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      coreWs.current?.close();
    };
  }, [patch, coreEnabled]);

  // ---- market data ---------------------------------------------------------
  const symRef = useRef(s.chartSym);
  const tfRef = useRef<Timeframe>(s.chartTf);
  useEffect(() => {
    symRef.current = s.chartSym;
    tfRef.current = s.chartTf;
  }, [s.chartSym, s.chartTf]);
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
    const tf = tfRef.current;
    void fetchCandles(sym, tf).then((cs) => {
      if (cs && cs.length > 2) patch((st) => ({ kl: { ...st.kl, [sym + "|" + tf]: cs } }));
    });
  }, [patch]);

  // Agents' ideas for the chart symbol, from core. Polled while core is connected; cleared when it goes away.
  const loadSignals = useCallback(() => {
    const sym = symRef.current;
    void fetchSignals(sym).then((list) => patch((st) => (st.core === "live" ? { signals: { ...st.signals, [sym]: list } } : null)));
  }, [patch]);
  useEffect(() => {
    if (s.core !== "live") return;
    loadSignals();
    const t = setInterval(loadSignals, 30_000);
    return () => clearInterval(t);
  }, [s.core, s.chartSym, loadSignals]);

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

  // New timeframe → new candles.
  const firstTf = useRef(true);
  useEffect(() => {
    if (firstTf.current) {
      firstTf.current = false;
      return;
    }
    loadCloses();
  }, [s.chartTf, loadCloses]);

  // ---- actions -------------------------------------------------------------
  const actions = useMemo(() => {
    const patchSel = (p: Partial<Agent>) => {
      const st0 = stateRef.current;
      patch((st) => ({ agents: st.agents.map((a, i) => (i === st.sel ? { ...a, ...p } : a)) }));
      if (st0.core === "live" && st0.sel !== null) {
        const f: CfgPatch = {};
        if (p.autonomy !== undefined) f.autonomy = p.autonomy;
        if (p.model !== undefined) f.model = p.model;
        if (p.temp !== undefined) f.temperature = p.temp;
        if (p.mandate !== undefined && p.mandate.length <= 2000) f.mandate = p.mandate;
        if (Object.keys(f).length) queueCfg(st0.sel, f);
      }
    };

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
      selectAgent: (sel: number | null) => {
        if (sel === null) flushCfg(); // APPLY / close: send anything still waiting
        patch({ sel });
      },
      selectSym: (chartSym: string) => patch({ chartSym }),
      setChartSrc: (chartSrc: "tv" | "native") => patch({ chartSrc }),
      setChartTf: (chartTf: Timeframe) => patch({ chartTf }),
      toggleChartFull: () => patch((st) => ({ chartFull: !st.chartFull })),
      closeChartFull: () => patch({ chartFull: false }),
      toggleSignals: () => patch((st) => ({ chartSignals: !st.chartSignals })),
      toggleHalt: () => {
        const st = stateRef.current;
        const ws = coreWs.current;
        if (st.core === "live" && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: st.halted ? "resume_all" : "halt_all" }));
        patch((cur) => ({ halted: !cur.halted }));
      },

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
      pauseSel: () => {
        const st0 = stateRef.current;
        if (st0.sel === null) return;
        if (st0.core === "live") queueCfg(st0.sel, { paused: !st0.agents[st0.sel]!.paused }, true);
        patch((st) => ({ agents: st.agents.map((a, i) => (i === st.sel ? { ...a, paused: !a.paused } : a)) }));
      },
      resetSel: () => {
        const st0 = stateRef.current;
        if (st0.core === "live" && st0.sel !== null) {
          const d = SEED_AGENTS[st0.sel]!;
          queueCfg(st0.sel, { autonomy: d.autonomy, model: d.model, temperature: d.temp, mandate: d.mandate, paused: false }, true);
        }
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
        });
      },

      setApprovalMult: (id: string, mult: number) =>
        patch((st) => ({ approvals: st.approvals.map((a) => (a.id === id ? { ...a, mult } : a)) })),
      decide: (id: string, ok: boolean) => {
        // Orders from core's agents are approved by core: send once, outside any state updater.
        const st0 = stateRef.current;
        const a0 = st0.approvals.find((x) => x.id === id);
        const ws = coreWs.current;
        if (ok && a0?.raw && st0.core === "live" && ws && ws.readyState === WebSocket.OPEN) {
          const ag = st0.agents[a0.who]!;
          const size = Math.floor(a0.q * a0.mult * 1e4) / 1e4;
          ws.send(JSON.stringify({ type: "place_order", role: ag.role, symbol: a0.k.replace("USDT", "-USDT"), side: a0.side, size }));
          patch((st) => ({
            approvals: st.approvals.filter((x) => x.id !== id),
            seq: st.seq.concat([{
              sysText: "YOU approved " + ag.name.split(" ")[0] + " · " + a0.side + " " + PERP(a0.k) + " " + fmtQty(size) + " · sent to core for the risk check",
              t: Date.now(),
            }]).slice(-80),
          }));
          return;
        }
        patch((st) => {
          const a = st.approvals.find((x) => x.id === id);
          if (!a) return null;
          const ag = st.agents[a.who];
          const now = Date.now();
          const px = st.live[a.k].px;
          const q = a.q * a.mult;
          const label = a.side + " " + PERP(a.k) + " " + fmtQty(q * (a.raw ? 1 : bookScale(st.setup)));
          const out: Partial<DeskState> = { approvals: st.approvals.filter((x) => x.id !== id) };
          const first = ag.name.split(" ")[0];
          if (ok) {
            const fill: Fill = { side: a.side, k: a.k, q, agent: ag.name, t: now, px, status: "FILLED", ...(a.raw ? { raw: true } : {}) };
            out.fills = [fill].concat(st.fills).slice(0, 40);
            out.seq = st.seq.concat([{
              sysText: "YOU approved " + first + " · " + label + " filled @ " + fmt(px, LBL[a.k].dp) + (st.mode === "live" ? "" : " · paper"),
              t: now,
            }]).slice(-80);
          } else {
            out.seq = st.seq.concat([{ sysText: "YOU rejected " + first + " · " + label, t: now }]).slice(-80);
          }
          return out;
        });
      },
    };
  }, [patch, queueCfg, flushCfg]);

  const view = useMemo(() => buildView(s), [s]);
  return { s, view, actions };
}

export type DeskActions = ReturnType<typeof useDesk>["actions"];
