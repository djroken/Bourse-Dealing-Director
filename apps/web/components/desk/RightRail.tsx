"use client";

import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import { ChartBody, ChartToggle, ChartTools } from "./Chart";
import { m } from "./ui";

const TAG_COLOR: Record<string, { color: string; border: string }> = {
  MACRO: { color: "var(--cFF7A7A)", border: "rgba(255,91,91,0.3)" },
  "ON-CHAIN": { color: "var(--c9AA5B1)", border: "rgba(154,165,177,0.3)" },
  FLOW: { color: "var(--cFFB13D)", border: "rgba(255,177,61,0.3)" },
  VENUE: { color: "var(--c9AA5B1)", border: "rgba(154,165,177,0.3)" },
  MARKET: { color: "var(--c98A3AD)", border: "rgba(152,163,173,0.3)" },
};

export default function RightRail({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  const c = v.chart;
  return (
    <section className="hz-rail">
      <div className="hz-panel hz-glass hz-rail-chart" style={{ flex: "1.15 0 auto" }}>
        <div className="hz-panel-head" style={{ padding: "0 12px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
            <span style={m(11.5, "0.1em", "var(--cE6EAEE)")}>{c.label}</span>
            <span style={m(10, undefined, "var(--c5D6873)")}>{c.tf} · {c.feedShort}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={m(12, undefined, c.color)}>{c.last}</span>
            <ChartToggle s={s} a={a} />
          </div>
        </div>
        <div style={{ padding: "6px 8px 0" }}>
          <ChartTools s={s} v={v} a={a} />
        </div>
        <div className="hz-rail-chart-body">
          {s.chartFull ? <div className="hz-chart-away">Chart is open full screen</div> : <ChartBody s={s} v={v} />}
        </div>
        <div className="hz-chartstats">
          <div><div style={m(8.5, "0.14em", "var(--c5D6873)")}>NET POS</div><div style={m(12.5, undefined, undefined, { marginTop: 3 })}>{c.netPos}</div></div>
          <div><div style={m(8.5, "0.14em", "var(--c5D6873)")}>FUNDING</div><div style={m(12.5, undefined, "var(--cFFB13D)", { marginTop: 3 })}>{c.funding}</div></div>
          <div><div style={m(8.5, "0.14em", "var(--c5D6873)")}>VOL 24H</div><div style={m(12.5, undefined, "var(--cB4BEC7)", { marginTop: 3 })}>{c.vol}</div></div>
        </div>
      </div>

      <div className="hz-panel hz-glass hz-rail-news" style={{ flex: "1 1 0" }}>
        <div className="hz-panel-head" style={{ height: 34, padding: "0 12px" }}>
          <span style={m(10, "0.18em", "var(--c98A3AD)")}>NEWS FEED</span>
          <span style={m(9, "0.12em", "var(--c7C8894)")} data-testid="news-label">{v.news.label}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {v.news.empty && <div className="hz-news" data-last="true" style={{ fontSize: 12, color: "var(--c6B7681)" }}>{v.news.empty}</div>}
          {v.news.rows.map((n, i) => {
            const t = TAG_COLOR[n.tag] ?? TAG_COLOR.MARKET!;
            return (
              <div key={n.key} className="hz-news" data-last={i === v.news.rows.length - 1} data-testid="news-row">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={m(8.5, "0.12em", t.color, { border: `1px solid ${t.border}`, padding: "1px 5px", borderRadius: 2 })}>{n.tag}</span>
                  <span style={m(9, undefined, "var(--c4E5862)")}>{n.age}</span>
                </div>
                {n.url ? (
                  <a className="hz-news-link" href={n.url} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--cD5DCE2)" }}>{n.headline}</a>
                ) : (
                  <div style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--cD5DCE2)" }}>{n.headline}</div>
                )}
                <div style={m(9.5, undefined, "var(--c6B7681)")}>{n.foot}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
