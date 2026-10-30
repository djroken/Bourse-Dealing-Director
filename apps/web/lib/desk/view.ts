// Derived, display-ready values for the Desk (port of the prototype's renderVals).
// Pure: DeskState in, strings/colours out. Components never format anything themselves.

import {
  type Autonomy, type Grp, type Side,
  APP_VERSION, LBL, PERP, POS, RUNTIME_NAMES, SCRIPT, TINTS, allTape,
} from "./data";
import { cm, fmt, fmtQty, hms, money, path } from "./format";
import { type DeskState, type Filter, type Tab, bookScale, capitalOf, rawPnl, venuesReady } from "./state";
import { type ResolvedTheme } from "./theme";
import { CORE_URL } from "./secrets";
import { isModelId } from "./core";
import { chartGeometry, simCandles, type ChartGeo } from "./chartgeo";
import { TF_MS, TF_TV, TIMEFRAMES, type Timeframe } from "./market";

const UP = "var(--c3ECF8E)";
const DOWN = "var(--cFF7A7A)";
const ACCENT = "var(--cFF9E2C)";
const MUTED = "var(--c7C8894)";

export interface TapeCell { key: string; sym: string; px: string; chg: string; color: string; active: boolean; sel: string | null }
export interface AgentCard {
  idx: number; name: string; role: string; model: string; autonomy: Autonomy; initials: string;
  tint: string; status: string; statusColor: string; pnl: string; pnlColor: string; exposure: string;
  spark: string; area: string; isAuto: boolean;
}
export interface ChatRow {
  key: string; time: string; kind: "msg" | "trade" | "sys"; who: string; role: string; tint: string; text: string;
  side: Side | ""; sideBg: string; sideColor: string; ticket: string;
}
export interface FillRow {
  key: string; time: string; side: Side; sym: string; qty: string; px: string; pnl: string; agent: string;
  status: string; sideColor: string; pnlColor: string; stColor: string;
}
export interface ScoreRow {
  key: string; name: string; sub: string; model: string; guest: boolean; tint: string;
  ideas: string; hit: string; hitColor: string; avg: string; avgColor: string; fills: string; win: string;
  pnl: string; pnlColor: string; dd: string; vetoes: string;
}
/** The selected seat's track record, for the drawer. */
export interface TrackView { hit: string; hitNote: string; win: string; winNote: string; pnl: string; pnlColor: string; dd: string; ideas: string; fills: string }
export interface SignalRow {
  key: string; time: string; who: string; side: "BUY" | "SELL"; sideColor: string; px: string; conf: string;
  result: string; resultColor: string; why: string; traded: boolean;
}
export interface LogRow { key: string; time: string; level: string; text: string; tint: string }
export interface ApprovalView {
  id: string; side: Side; sym: string; qty: string; agent: string; role: string; tint: string; why: string; age: string;
  kindLabel: string; px: string; notional: string; navPct: string; sideBg: string; sideColor: string; cta: string; mult: number;
}
export interface SelView {
  idx: number; name: string; role: string; model: string; mandate: string; initials: string; tint: string;
  temp: number; tokens: string; spend: string; latency: string; maxClip: string; leverage: string; lossStop: string;
  autonomy: Autonomy; paused: boolean; tools: string[];
  /** Null while core isn't connected: there is no real record to show. */
  track: TrackView | null;
  /** What the TOKENS / SPEND / LATENCY boxes mean right now. */
  usageNote: string;
}

export interface DeskView {
  isMobile: boolean;
  isLive: boolean;
  resolved: ResolvedTheme;
  clock: string;
  tape: TapeCell[];
  filters: Array<{ id: Filter; label: string; active: boolean }>;
  roster: AgentCard[];
  rosterCount: string;
  chat: ChatRow[];
  fills: FillRow[];
  logs: LogRow[];
  approvals: ApprovalView[];
  nAppr: number;
  tabs: Array<{ id: Tab; label: string; active: boolean }>;
  scores: ScoreRow[];
  /** Explains the scores tab: what the numbers mean, or why there are none. */
  scoresNote: string;
  exportUrl: string;
  centerMeta: string;
  /** The honesty strip above the floor chat. */
  strip: string;
  navStr: string;
  pnlStr: string;
  pnlColor: string;
  chart: {
    label: string; feedShort: string; last: string; color: string; path: string; area: string;
    tvSrc: string; netPos: string; funding: string; vol: string;
    tf: Timeframe;
    tfs: Array<{ id: Timeframe; label: string; active: boolean }>;
    geo: ChartGeo;
    /** No exchange answered: the candles are a labelled stand-in. */
    simulated: boolean;
    full: boolean;
    /** Stocks: whether the US market is open, and that agents wait for it. Empty for crypto. */
    marketNote: string;
    isStock: boolean;
    signalsOn: boolean;
    /** What the SIGNALS layer is showing, or why it's empty. */
    signalNote: string;
    signalRows: SignalRow[];
  };
  engineState: string;
  engineColor: string;
  feedLabel: string;
  runtimeLabel: string;
  lastFill: string;
  modeLabel: string;
  liveBanner: string;
  liveBannerShort: string;
  liveModal: { title: string; body: string; cta: string; ready: boolean };
  sel: SelView | null;
  glassPct: number;
  capitalLabel: string;
}

const grpName: Array<[Filter, string]> = [["ALL", "ALL"], ["dir", "DIRECTION"], ["exec", "EXECUTION"], ["res", "RESEARCH"], ["risk", "RISK"]];
const tabDefs: Array<[Tab, string]> = [["chat", "FLOOR CHAT"], ["approvals", "APPROVALS"], ["blotter", "BLOTTER"], ["scores", "SCORES"], ["replay", "REPLAY"], ["console", "CONSOLE"]];

const pct = (r: number | null): string => (r === null ? "—" : Math.round(r * 100) + "%");
const signedPct = (v: number | null): string => (v === null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%");
const normRole = (r: string) => r.toUpperCase().replace(/\s+/g, " ").trim();

const sideStyle = (side: Side) => ({
  sideBg: side === "SELL" ? "rgba(255,91,91,0.14)" : "rgba(62,207,142,0.14)",
  sideColor: side === "SELL" ? DOWN : UP,
});

export function resolveTheme(s: DeskState): ResolvedTheme {
  return s.theme === "system" ? (s.sysDark ? "dark" : "light") : s.theme;
}

export function buildView(s: DeskState): DeskView {
  const { setup } = s;
  const scale = bookScale(setup);
  const capital = capitalOf(setup);
  const isLive = s.mode === "live";
  const core = s.core === "live";
  const resolved = resolveTheme(s);
  const ready = venuesReady(setup);
  const venueNames = ready.map((v) => v.name).join(", ");
  const runtimeName = RUNTIME_NAMES[setup.runtime] ?? RUNTIME_NAMES.hermes;

  const tape: TapeCell[] = allTape().map((t): TapeCell => {
    const p = s.live[t.k] ?? { px: Number.NaN, chg: 0, vol: 0 };
    const closed = t.kind === "stock" && s.market[t.k] === false;
    const priced = Number.isFinite(p.px);
    return {
      key: t.k, sym: t.label, px: fmt(p.px, t.dp),
      chg: !priced ? "—" : closed ? "CLOSED" : (p.chg >= 0 ? "+" : "") + p.chg.toFixed(2) + "%",
      color: !priced || closed ? "var(--c6B7681)" : p.chg >= 0 ? UP : DOWN,
      active: s.chartSym === t.k, sel: t.k,
    };
  }).concat([{
    key: "EURUSD", sym: "EUR/USD", px: s.fx ? s.fx.toFixed(4) : "—", chg: "ECB",
    color: "var(--c6B7681)", active: false, sel: null,
  }]);

  const onFloor = s.agents.map((a, i) => ({ a, i })).filter((x) => setup.agentsOn[x.i] !== false);
  const visible = onFloor.filter((x) => s.filter === "ALL" || x.a.grp === s.filter);

  const roster: AgentCard[] = visible.map(({ a, i }) => {
    const p = POS[i];
    const raw = rawPnl(i, s.live, s.ref);
    const cb = core ? s.coreBook[i] : undefined;
    const net = cb ? cb.positions.reduce((x, q) => x + q.qty * s.live[q.k]!.px, 0) : 0;
    const statusColor = a.paused ? "var(--cFFC078)" : a.grp === "risk" ? "var(--c9AA5B1)" : ACCENT;
    return {
      idx: i, name: a.name, role: a.role, model: a.model, autonomy: a.autonomy,
      initials: a.name.split(" ").map((w) => w[0]).join(""),
      tint: TINTS[a.grp], status: a.paused ? "PAUSED" : a.status, statusColor,
      pnl: core ? (cb ? money(cb.pnl) : "—") : p ? money(raw * scale) : "—",
      pnlColor: core ? (cb ? (cb.pnl >= 0 ? UP : DOWN) : MUTED) : p ? (raw >= 0 ? UP : DOWN) : MUTED,
      exposure: core ? (cb && cb.exposure > 0 ? cm(cb.exposure) + (net < 0 ? " S" : " L") : "—") : p ? cm(p.q * s.live[p.k].px * scale) + (p.q < 0 ? " S" : " L") : "—",
      spark: path(s.series[i], 200, 34, false), area: path(s.series[i], 200, 34, true),
      isAuto: a.autonomy === "AUTO",
    };
  });

  const chat: ChatRow[] = s.seq.map((e, n) => {
    const base: ChatRow = {
      key: e.t + ":" + n, time: hms(e.t), kind: "msg", who: "", role: "", tint: "var(--cE6EAEE)", text: "",
      side: "", sideBg: "", sideColor: "", ticket: "",
    };
    if (e.user) return { ...base, who: "YOU", role: "PORTFOLIO OWNER", text: e.user };
    if (e.sysText) return { ...base, kind: "sys", tint: ACCENT, text: e.sysText };
    if (e.reply) return { ...base, who: "Vega", role: "DEALING DIRECTOR", tint: TINTS.dir, text: e.reply };
    if (e.say !== undefined && e.agent !== undefined && s.agents[e.agent]) {
      // A seat speaking in core's floor conversation. The role line says who wrote it: a model, or the stub rule.
      const a = s.agents[e.agent]!;
      return { ...base, who: a.name.split(" ")[0]!, role: a.role + (e.model ? " · " + e.model : e.stub ? " · STUB RULE" : ""), tint: TINTS[a.grp as Grp], text: e.say };
    }
    const m = SCRIPT[e.i as number];
    const a = s.agents[m.who];
    const row: ChatRow = { ...base, who: a.name.split(" ")[0], role: a.role, tint: TINTS[a.grp as Grp] };
    if (m.kind === "msg") return { ...row, text: m.text };
    if (m.kind === "sys") return { ...row, kind: "sys", text: m.text };
    if (m.kind === "intent") {
      return {
        ...row,
        text: "Proposing " + m.side + " " + PERP(m.k) + " " + fmtQty(m.q * scale) + ". " + m.why +
          (e.queued ? " Sent to your approvals queue." : " Executing on AUTO."),
      };
    }
    // trade
    if (e.queued) {
      return {
        ...row, kind: "sys",
        text: "QUEUED · " + m.side + " " + PERP(m.k) + " " + fmtQty(m.q * scale) + " @ " + fmt(e.px, LBL[m.k].dp) + " · awaiting your approval",
      };
    }
    return {
      ...row, kind: "trade", side: m.side, ...sideStyle(m.side),
      text: PERP(m.k) + "  " + fmtQty(m.q * scale) + " @ " + fmt(e.px, LBL[m.k].dp) + (isLive ? "" : "  · PAPER"),
      ticket: "TKT-" + String(Math.floor(e.t / 1000) % 100000).padStart(5, "0"),
    };
  });

  const nAppr = s.approvals.length;
  const tabs = tabDefs.map(([id, label]) => ({
    id, label: id === "approvals" && nAppr ? label + " · " + nAppr : label, active: s.tab === id,
  }));

  const fills: FillRow[] = s.fills.map((fl, n) => {
    const now = s.live[fl.k].px;
    const sc = fl.raw ? 1 : scale;
    const pnl = (fl.side === "BUY" ? 1 : -1) * fl.q * (now - fl.px) * sc;
    return {
      key: fl.t + ":" + n, time: hms(fl.t), side: fl.side, sym: PERP(fl.k), qty: fmtQty(fl.q * sc),
      px: fmt(fl.px, LBL[fl.k].dp), pnl: money(pnl), agent: fl.agent, status: isLive ? fl.status : "PAPER",
      sideColor: fl.side === "SELL" ? DOWN : UP, pnlColor: pnl < 0 ? DOWN : UP,
      stColor: fl.status === "SETTLED" ? "var(--c5D6873)" : "var(--c9AA5B1)",
    };
  });

  const feedName = ({
    BINANCE: "binance public · data-api.binance.vision",
    COINBASE: "coinbase exchange public",
    SIMULATED: "no public feed reachable · simulating",
    CONNECTING: "connecting…",
  } as const)[s.feed];
  const muted = "var(--c9AA5B1)";
  const logBase: Array<{ level: string; text: string; tint: string; t?: number }> = [
    { level: "BOOT", text: "bourse desk " + APP_VERSION + " · " + (core ? "core floor" : "simulated floor") + " · " + onFloor.length + " agents · mode " + (isLive ? "LIVE" : "demo / paper only"), tint: "var(--c6B7681)" },
    { level: "RUNTIME", text: core ? "agent runtime → bourse core · scripted momentum agents, not AI models (" + runtimeName + " selected in setup, not connected yet)" : "agent runtime → simulated (" + runtimeName + " selected in setup, not connected yet)", tint: muted },
    { level: "FEED", text: "prices → " + feedName, tint: s.feed === "SIMULATED" ? DOWN : muted },
    { level: "FEED", text: "charts → " + (s.chartSrc === "tv" ? "tradingview widget " : "native ") + LBL[s.chartSym].tv + " · candles " + (s.kl[s.chartSym + "|" + s.chartTf] ? "loaded" : "pending"), tint: muted },
    { level: "FEED", text: "fx → frankfurter (ECB daily) " + (s.fx ? "EUR/USD " + s.fx.toFixed(4) : "pending"), tint: muted },
    { level: "ROUTE", text: "execution → " + (isLive ? venueNames : "paper venue · fills at live mid"), tint: isLive ? DOWN : muted },
    { level: "POLICY", text: "risk · daily loss stop $" + setup.lossStop + " · max leverage " + setup.lev + "x · capital " + cm(capital), tint: "var(--cFFB13D)" },
  ];
  const orderLogs = s.fills.slice(0, 8).map((fl) => ({
    level: "ORDER", tint: ACCENT, t: fl.t,
    text: fl.agent.toLowerCase().replace(" ", ".") + " → " + fl.side.toLowerCase() + " " + PERP(fl.k) + " " + fmtQty(fl.q * (fl.raw ? 1 : scale)) + " @ " + fmt(fl.px, LBL[fl.k].dp) + (isLive ? "" : " · paper"),
  }));
  const logs: LogRow[] = logBase.concat(orderLogs).map((l, n) => ({
    key: n + ":" + l.level, time: hms(l.t ?? s.now), level: l.level, text: l.text, tint: l.tint,
  }));

  const sessionRaw = onFloor.reduce((x, o) => x + rawPnl(o.i, s.live, s.ref), 0);
  const pnl = core ? onFloor.reduce((x, o) => x + (s.coreBook[o.i]?.pnl ?? 0), 0) : sessionRaw * scale;

  const tf = s.chartTf;
  const loaded = s.kl[s.chartSym + "|" + tf];
  const livePx = s.live[s.chartSym]?.px ?? Number.NaN;
  // No candles yet: a labelled stand-in for the built-in coins; nothing at all for core's instruments until core answers.
  const candles = loaded ?? (Number.isFinite(livePx) ? simCandles(livePx, TF_MS[tf], s.now) : []);
  const chartInst = LBL[s.chartSym];
  const isStock = chartInst?.kind === "stock";
  const mkt = s.stocks?.market;
  const marketNote = !isStock ? "" : s.market[s.chartSym] === false || mkt?.open === false
    ? "US MARKET CLOSED" + (mkt?.nextOpen ? " · OPENS " + mkt.nextOpen.slice(0, 16).replace("T", " ") + " ET" : "") + " · AGENTS WAIT FOR THE OPEN"
    : "US MARKET OPEN · PRICES FROM ALPACA (IEX)";
  const series = candles.map((c) => c.c).slice(0, -1).concat([s.live[s.chartSym].px]);
  const chartUp = series[series.length - 1] >= series[0];
  const symSignals = core ? (s.signals[s.chartSym] ?? []) : [];
  const dp = LBL[s.chartSym].dp;
  const geo = chartGeometry(candles, s.live[s.chartSym].px, s.chartSignals ? symSignals : [], TF_MS[tf], dp, s.now);
  const signalNote = !core
    ? "Signals come from Bourse Core's agents. Start core (pnpm dev) to see their ideas here."
    : !symSignals.length
      ? "No agent ideas on this symbol yet."
      : `${symSignals.length} agent idea${symSignals.length > 1 ? "s" : ""} · ${geo.visibleSignals} in view · ▲ buy ▼ sell · green right, red wrong, amber not scored yet`;
  const signalRows: SignalRow[] = symSignals.slice(-40).reverse().map((g) => ({
    key: g.id, time: hms(g.t), who: g.name, side: g.side, sideColor: g.side === "BUY" ? UP : DOWN, px: fmt(g.px, dp),
    conf: Math.round(g.confidence * 100) + "%",
    result: g.outcome ? (g.outcome.returnPct >= 0 ? "+" : "") + g.outcome.returnPct.toFixed(2) + "%" : "open",
    resultColor: !g.outcome ? ACCENT : g.outcome.correct ? UP : DOWN,
    why: g.why, traded: g.filled,
  }));
  const netQ = core
    ? onFloor.reduce((x, o) => x + (s.coreBook[o.i]?.positions.find((q) => q.k === s.chartSym)?.qty ?? 0), 0)
    : onFloor.reduce((x, o) => x + (POS[o.i] && POS[o.i]!.k === s.chartSym ? POS[o.i]!.q * scale : 0), 0);
  const vol = s.live[s.chartSym]?.vol ?? 0;
  const light = resolved === "light";
  const tvSrc =
    "https://s.tradingview.com/widgetembed/?frameElementId=bourse_tv&symbol=" + encodeURIComponent(LBL[s.chartSym].tv) +
    "&interval=" + TF_TV[tf] + "&hidesidetoolbar=" + (s.chartFull ? "0" : "1") + "&symboledit=0&saveimage=0&toolbarbg=" + (light ? "FFFFFF" : "161A20") +
    "&studies=%5B%5D&theme=" + (light ? "light" : "dark") + "&style=1&timezone=Etc%2FUTC&withdateranges=" + (s.chartFull ? "1" : "0") + "&hideideas=1&locale=en";

  const ago = (t: number) => {
    const sec = Math.max(0, Math.round((s.now - t) / 1000));
    return sec < 60 ? sec + "s ago" : Math.floor(sec / 60) + "m ago";
  };
  const approvals: ApprovalView[] = s.approvals.map((a) => {
    const ag = s.agents[a.who];
    const px = s.live[a.k].px;
    const q = a.q * a.mult * (a.raw ? 1 : scale);
    return {
      id: a.id, side: a.side, sym: PERP(a.k), qty: fmtQty(q), agent: ag.name, role: ag.role, tint: TINTS[ag.grp], why: a.why,
      age: ago(a.t), kindLabel: a.kind === "SUGGEST" ? "SUGGESTION" : "NEEDS APPROVAL",
      px: fmt(px, LBL[a.k].dp), notional: cm(q * px), navPct: ((q * px) / capital * 100).toFixed(1) + "%",
      ...sideStyle(a.side), cta: a.kind === "SUGGEST" ? "PLACE ORDER" : "APPROVE", mult: a.mult,
    };
  }).reverse();

  const selAgent = s.sel === null ? null : s.agents[s.sel];
  // ---- scorecards (core only) ----
  const seatTint = (role: string): string => {
    const a = s.agents.find((x) => normRole(x.role) === normRole(role));
    return a ? TINTS[a.grp] : MUTED;
  };
  const seatOrder = (role: string): number => {
    const i = s.agents.findIndex((x) => normRole(x.role) === normRole(role));
    return i < 0 ? 1000 : i;
  };
  const cards = core ? Object.values(s.scores) : [];
  const scores: ScoreRow[] = cards
    .slice()
    .sort((x, y) => seatOrder(x.role) - seatOrder(y.role) || x.role.localeCompare(y.role))
    .map((c) => {
      const guest = /^guest:/i.test(c.role.trim());
      return {
        key: c.agentId, name: c.name, sub: guest ? "GUEST · MCP" : c.role.toUpperCase(), model: c.model, guest,
        tint: guest ? "var(--c9AA5B1)" : seatTint(c.role),
        ideas: String(c.ideas),
        hit: c.scored ? pct(c.hitRate) + " of " + c.scored : "—",
        hitColor: c.hitRate === null ? MUTED : c.hitRate >= 0.5 ? UP : DOWN,
        avg: signedPct(c.avgReturnPct),
        avgColor: c.avgReturnPct === null ? MUTED : c.avgReturnPct >= 0 ? UP : DOWN,
        fills: String(c.fills),
        win: c.closes ? pct(c.winRate) + " of " + c.closes : "—",
        pnl: c.fills || c.pnl ? money(c.pnl) : "—",
        pnlColor: !(c.fills || c.pnl) ? MUTED : c.pnl >= 0 ? UP : DOWN,
        dd: c.maxDrawdown > 0 ? "-" + cm(c.maxDrawdown) : "—",
        vetoes: String(c.vetoes),
      };
    });
  const scoresNote = !core
    ? "Scorecards come from Bourse Core. Start it with pnpm dev and each agent's paper record builds up here."
    : "HIT RATE: ideas that moved the right way 15 min later (configurable), traded or not. WIN RATE: closed paper trades that made money. Paper only.";

  const selScore = selAgent && core ? cards.find((c) => normRole(c.role) === normRole(selAgent.role)) : undefined;
  const track: TrackView | null = !core || !selAgent ? null : {
    hit: pct(selScore?.hitRate ?? null), hitNote: selScore?.scored ? `${selScore.hits} of ${selScore.scored} ideas` : "no ideas scored yet",
    win: pct(selScore?.winRate ?? null), winNote: selScore?.closes ? `${selScore.wins} of ${selScore.closes} closed` : "no closed trades yet",
    pnl: selScore && (selScore.fills || selScore.pnl) ? money(selScore.pnl) : "—",
    pnlColor: !selScore || !(selScore.fills || selScore.pnl) ? MUTED : selScore.pnl >= 0 ? UP : DOWN,
    dd: selScore && selScore.maxDrawdown > 0 ? "-" + cm(selScore.maxDrawdown) : "—",
    ideas: String(selScore?.ideas ?? 0), fills: String(selScore?.fills ?? 0),
  };

  const sel: SelView | null = selAgent && s.sel !== null ? {
    idx: s.sel, name: selAgent.name, role: selAgent.role, model: selAgent.model, mandate: selAgent.mandate,
    initials: selAgent.name.split(" ").map((w) => w[0]).join(""), tint: TINTS[selAgent.grp],
    temp: selAgent.temp, tokens: selAgent.tokens, spend: selAgent.spend, latency: selAgent.latency,
    maxClip: selAgent.maxClip, leverage: selAgent.leverage, lossStop: selAgent.lossStop,
    autonomy: selAgent.autonomy, paused: selAgent.paused, tools: selAgent.tools, track,
    usageNote: !core
      ? "Sample figures: the simulated floor makes no model calls."
      : isModelId(selAgent.model)
        ? "Today (UTC), counted by core. Spend shows n/a when the provider doesn't report cost; Ollama is free."
        : "This seat runs core's stub rule: no model calls and no cost. Pick an ollama: or openrouter: model to make it think.",
  } : null;

  const nModel = onFloor.filter((x) => isModelId(x.a.model)).length;
  const coreSeats = nModel === 0 ? "stub agents (not AI)" : nModel === onFloor.length ? `${nModel} model agents` : `${nModel} model + ${onFloor.length - nModel} stub agents`;
  const lastFill = fills[0]
    ? "LAST FILL · " + fills[0].side + " " + fills[0].qty + " " + fills[0].sym + " @ " + fills[0].px + " · " + fills[0].agent
    : "";

  return {
    isMobile: s.vw < 760,
    isLive, resolved,
    clock: hms(s.now) + " UTC",
    tape,
    filters: grpName.map(([id, label]) => ({ id, label, active: s.filter === id })),
    roster, rosterCount: visible.length + " / " + onFloor.length + " AGENTS",
    chat, fills, logs, approvals, nAppr, tabs, scores, scoresNote, exportUrl: CORE_URL + "/export/ideas.jsonl",
    strip: core
      ? `CORE FLOOR · ${coreSeats} · paper book on real prices · not advice`
      : "SIMULATED FLOOR · scripted agents, paper fills, real prices · not advice",
    centerMeta: (core ? "CORE" : "SIMULATED") + " · " + s.seq.length + " EVENTS",
    navStr: cm(capital + pnl), pnlStr: money(pnl), pnlColor: pnl >= 0 ? UP : DOWN,
    chart: {
      label: LBL[s.chartSym].label, feedShort: isStock ? "ALPACA" : s.feed, last: fmt(s.live[s.chartSym].px, LBL[s.chartSym].dp),
      color: chartUp ? UP : DOWN, path: path(series, 320, 190, false), area: path(series, 320, 190, true), tvSrc,
      netPos: (netQ >= 0 ? "+" : "") + fmtQty(netQ) + " " + s.chartSym.replace("USDT", ""),
      funding: s.funding === null ? "—" : (s.funding >= 0 ? "+" : "") + s.funding.toFixed(4) + "%",
      vol: vol ? cm(vol) : "—",
      tf, tfs: TIMEFRAMES.map((id) => ({ id, label: id.toUpperCase(), active: id === tf })),
      geo, simulated: !loaded && candles.length > 0, full: s.chartFull, marketNote, isStock, signalsOn: s.chartSignals, signalNote, signalRows,
    },
    engineState: s.halted ? "HALTED BY OPERATOR" : core ? "CORE FLOOR" : "SIMULATED FLOOR",
    engineColor: s.halted ? DOWN : ACCENT,
    feedLabel: "FEED " + s.feed + (s.feed === "SIMULATED" ? "" : " · 5s"),
    runtimeLabel: core ? `RUNTIME BOURSE CORE (${nModel ? `${nModel} MODEL / ${onFloor.length - nModel} STUB` : "STUB AGENTS"})` : "RUNTIME SIMULATED",
    lastFill,
    modeLabel: "BOURSE v" + APP_VERSION + " · " + (isLive ? "LIVE" : "DEMO · PAPER ONLY"),
    liveBanner: "LIVE · ORDERS ROUTE TO " + (venueNames || "NO VENUE").toUpperCase() + " · AGENTS ON AUTO PLACE REAL ORDERS",
    liveBannerShort: "LIVE · " + (venueNames || "NO VENUE").toUpperCase(),
    liveModal: {
      ready: ready.length > 0,
      title: ready.length ? "Switch to live trading?" : "Connect a venue first",
      body: ready.length
        ? "Orders from agents set to AUTO will route to " + venueNames + ". Paper positions are not carried over. Risk limits: daily loss stop $" + setup.lossStop + ", max leverage " + setup.lev + "x."
        : "Live mode needs at least one venue with trade-enabled API keys. The Demo desk keeps running on live prices in the meantime.",
      cta: ready.length ? "GO LIVE" : "OPEN SETUP",
    },
    sel,
    glassPct: Math.round(s.glassAlpha * 100),
    capitalLabel: cm(capital),
  };
}
