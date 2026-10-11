"use client";

import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";

/** TradingView embed or the native SVG line, depending on the TV / NATIVE toggle. */
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
  return (
    <svg viewBox="0 0 320 190" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }} role="img" aria-label={`${v.chart.label} 5 minute chart`}>
      {grid && [47, 95, 143].map((y) => (
        <line key={y} x1="0" y1={y} x2="320" y2={y} strokeWidth={1} style={{ stroke: "var(--w05)" }} />
      ))}
      <path d={v.chart.area} style={{ fill: "rgba(255,158,44,0.08)" }} />
      <path d={v.chart.path} fill="none" strokeWidth={1.6} style={{ stroke: v.chart.color }} />
    </svg>
  );
}

export function ChartToggle({ s, a, size = "sm" }: { s: DeskState; a: DeskActions; size?: "sm" | "lg" }) {
  return (
    <div className="hz-seg hz-seg--chart" data-size={size} role="group" aria-label="Chart source">
      <button data-on={s.chartSrc === "tv"} onClick={() => a.setChartSrc("tv")}>TV</button>
      <button data-on={s.chartSrc !== "tv"} onClick={() => a.setChartSrc("native")}>NATIVE</button>
    </div>
  );
}
