"use client";

import { useEffect } from "react";
import { TAPE } from "@/lib/desk/data";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

const UP = "var(--c3ECF8E)";
const DOWN = "var(--cFF7A7A)";
const MARK: Record<"hit" | "miss" | "open", string> = { hit: UP, miss: DOWN, open: "var(--cFF9E2C)" };

/** Native candles with agents' ideas on top. Candles are SVG; labels and markers are HTML so they stay crisp and hoverable. */
function NativeChart({ v, grid }: { v: DeskView; grid: boolean }) {
  const g = v.chart.geo;
  return (
    <div className="hz-native" role="img" aria-label={`${v.chart.label} ${v.chart.tf} candles${v.chart.signalsOn ? ` with ${g.markers.length} signal markers` : ""}`}>
      <div className="hz-native-plot">
      <svg viewBox={`0 0 ${g.W} ${g.H}`} preserveAspectRatio="none" className="hz-native-svg" aria-hidden="true">
        {grid && g.grid.map((l) => <line key={l.y} x1="0" y1={l.y} x2={g.W} y2={l.y} strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--w05)" }} />)}
        {g.candles.map((c) => {
          const col = c.up ? UP : DOWN;
          return (
            <g key={c.key}>
              <line x1={c.x + c.w / 2} x2={c.x + c.w / 2} y1={c.wickY1} y2={c.wickY2} strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ stroke: col }} />
              <rect x={c.x} y={c.bodyY} width={c.w} height={c.bodyH} style={{ fill: col, opacity: c.up ? 0.85 : 0.9 }} />
            </g>
          );
        })}
      </svg>
      {v.chart.signalsOn && g.markers.map((mk) => (
        <button
          key={mk.key}
          className="hz-mk"
          data-side={mk.side}
          data-state={mk.state}
          style={{ left: `${mk.xPct}%`, top: `${mk.yPct}%`, color: MARK[mk.state] }}
          aria-label={`${mk.title}. ${mk.lines.join(". ")}`}
          data-testid="signal-marker"
        >
          <span aria-hidden="true">{mk.side === "BUY" ? "▲" : "▼"}</span>
          {mk.count > 1 && <span className="hz-mk-n" aria-hidden="true">{mk.count}</span>}
          <span className="hz-mk-tip" role="tooltip" data-edge={mk.xPct > 70 ? "right" : mk.xPct < 30 ? "left" : "mid"}>
            <span style={m(9, "0.12em", MARK[mk.state], { display: "block", marginBottom: 4 })}>{mk.title.toUpperCase()}</span>
            {mk.lines.map((l, i) => <span key={i} className="hz-mk-line">{l}</span>)}
          </span>
        </button>
      ))}
      </div>
      {grid && g.grid.map((l) => (
        <span key={l.y} className="hz-native-px" style={{ top: `${l.yPct}%` }}>{l.label}</span>
      ))}
      <span className="hz-native-last" style={{ top: `${g.lastYPct}%`, background: g.up ? "rgba(62,207,142,0.9)" : "rgba(255,122,122,0.9)" }}>{g.lastLabel}</span>
      {v.chart.simulated && <span className="hz-native-sim">SIMULATED CANDLES · NO EXCHANGE REACHABLE</span>}
    </div>
  );
}

/** TradingView embed or the native candles, depending on the TV / NATIVE toggle. */
export function ChartBody({ s, v, grid = true }: { s: DeskState; v: DeskView; grid?: boolean }) {
  if (s.chartSrc === "tv") {
    return (
      <iframe
        key={v.chart.tvSrc}
        src={v.chart.tvSrc}
        title="TradingView chart"
        style={{ width: "100%", height: "100%", border: 0, display: "block", borderRadius: 2 }}
      />
    );
  }
  return <NativeChart v={v} grid={grid} />;
}

export function ChartToggle({ s, a, size = "sm" }: { s: DeskState; a: DeskActions; size?: "sm" | "lg" }) {
  return (
    <div className="hz-seg hz-seg--chart" data-size={size} role="group" aria-label="Chart source">
      <button data-on={s.chartSrc === "tv"} onClick={() => a.setChartSrc("tv")}>TV</button>
      <button data-on={s.chartSrc !== "tv"} onClick={() => a.setChartSrc("native")}>NATIVE</button>
    </div>
  );
}

/** Timeframes, the signals layer and full screen. */
export function ChartTools({ s, v, a, size = "sm" }: { s: DeskState; v: DeskView; a: DeskActions; size?: "sm" | "lg" }) {
  return (
    <div className="hz-charttools" data-size={size}>
      <div className="hz-seg hz-seg--chart" data-size={size} role="group" aria-label="Timeframe">
        {v.chart.tfs.map((t) => (
          <button key={t.id} data-on={t.active} aria-pressed={t.active} onClick={() => a.setChartTf(t.id)}>{t.label}</button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <button
        className="hz-chip hz-chip--tool" data-on={v.chart.signalsOn} aria-pressed={v.chart.signalsOn} data-size={size}
        disabled={s.chartSrc === "tv"} title={s.chartSrc === "tv" ? "Signals show on the NATIVE chart" : v.chart.signalNote}
        onClick={a.toggleSignals}
      >
        SIGNALS
      </button>
      <button className="hz-x hz-x--tool" data-size={size} aria-label={v.chart.full ? "Exit full screen" : "Full screen chart"} title={v.chart.full ? "Exit full screen (Esc)" : "Full screen"} onClick={a.toggleChartFull}>
        {v.chart.full ? "⤡" : "⤢"}
      </button>
    </div>
  );
}

/** The chart over the whole window: symbol picker, tools, the chart, and the list of agents' ideas beside it. */
export function ChartFull({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.closeChartFull();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);
  const c = v.chart;
  const showList = s.chartSrc !== "tv" && !v.isMobile;
  return (
    <div className="hz-chartfull hz-glass" role="dialog" aria-modal="true" aria-label={`${c.label} chart, full screen`}>
      <div className="hz-chartfull-head">
        <div className="hz-seg hz-seg--chart" data-size="lg" role="group" aria-label="Symbol">
          {TAPE.map((t) => (
            <button key={t.k} data-on={s.chartSym === t.k} onClick={() => a.selectSym(t.k)}>{t.label}</button>
          ))}
        </div>
        <span style={m(16, undefined, c.color, { marginLeft: 6 })}>{c.last}</span>
        <span style={m(9.5, "0.12em", "var(--c5D6873)")}>{c.feedShort}</span>
        <div style={{ flex: 1 }} />
        <ChartToggle s={s} a={a} size="lg" />
        <div style={{ width: 340, maxWidth: "50vw" }}><ChartTools s={s} v={v} a={a} size="lg" /></div>
      </div>
      <div className="hz-chartfull-body">
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, padding: 10 }}>
          <ChartBody s={s} v={v} />
        </div>
        {showList && (
          <aside className="hz-sigs" aria-label="Agent ideas on this symbol">
            <div style={m(9.5, "0.16em", "var(--c98A3AD)", { padding: "12px 14px 6px" })}>AGENT IDEAS · {c.label}</div>
            <div style={m(9.5, "0.04em", "var(--c6B7681)", { padding: "0 14px 10px", lineHeight: 1.5 })}>{c.signalNote}</div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {c.signalRows.map((r) => (
                <div key={r.key} className="hz-sig" data-testid="signal-row">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={m(9.5, undefined, "var(--c5D6873)")}>{r.time}</span>
                    <span style={m(10, "0.08em", r.sideColor, { fontWeight: 600 })}>{r.side}</span>
                    <span style={m(10.5, undefined, "var(--cE6EAEE)")}>@ {r.px}</span>
                    <span style={{ flex: 1 }} />
                    <span style={m(10.5, undefined, r.resultColor)}>{r.result}</span>
                  </div>
                  <div style={m(9.5, "0.06em", "var(--c98A3AD)", { marginTop: 3 })}>{r.who} · {r.conf} confidence{r.traded ? " · traded" : ""}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--cC9D2DA)", marginTop: 4 }}>{r.why}</div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
