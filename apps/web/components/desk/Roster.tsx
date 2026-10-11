"use client";

import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

export default function Roster({ v, a }: { v: DeskView; a: DeskActions }) {
  return (
    <section className="hz-panel hz-roster hz-glass">
      <div className="hz-panel-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={m(10, "0.18em", "var(--c98A3AD)")}>FLOOR ROSTER</span>
          <span style={m(10, undefined, "var(--c4E5862)")}>{v.rosterCount}</span>
        </div>
        <div className="hz-chips">
          {v.filters.map((f) => (
            <button key={f.id} className="hz-chip" data-on={f.active} onClick={() => a.setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hz-roster-grid">
        {v.roster.map((c) => (
          <div
            key={c.idx}
            className="hz-agent"
            role="button"
            tabIndex={0}
            aria-label={`${c.name}, ${c.role}. Open settings`}
            onClick={() => a.selectAgent(c.idx)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                a.selectAgent(c.idx);
              }
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", gap: 9, minWidth: 0 }}>
                <div className="hz-initials" style={{ color: c.tint }}>{c.initials}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--cEDF1F4)", lineHeight: 1.2 }}>{c.name}</div>
                  <div className="hz-ellipsis" style={m(9, "0.1em", "var(--c6B7681)", { marginTop: 3 })}>{c.role}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                <span className="hz-dot hz-pulse" style={{ background: c.statusColor }} />
                <span style={m(8.5, "0.1em", c.statusColor)}>{c.status}</span>
              </div>
            </div>

            <svg viewBox="0 0 200 34" preserveAspectRatio="none" style={{ width: "100%", height: 30, display: "block" }} aria-hidden>
              <path d={c.area} style={{ fill: "var(--w05)" }} />
              <path d={c.spark} fill="none" strokeWidth={1.4} style={{ stroke: c.pnlColor }} />
            </svg>

            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
              <div>
                <div style={m(8.5, "0.14em", "var(--c5D6873)")}>P&amp;L</div>
                <div style={m(14, undefined, c.pnlColor, { fontWeight: 500, marginTop: 2 })}>{c.pnl}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={m(8.5, "0.14em", "var(--c5D6873)")}>EXPOSURE</div>
                <div style={m(12, undefined, "var(--cB4BEC7)", { marginTop: 3 })}>{c.exposure}</div>
              </div>
            </div>

            <div className="hz-agent-foot">
              <span className="hz-ellipsis" style={m(9, undefined, "var(--c7C8894)", { whiteSpace: "nowrap" })}>{c.model}</span>
              <span className="hz-pill" data-auto={c.isAuto}>{c.autonomy}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
