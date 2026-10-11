"use client";

import type { DeskActions } from "@/lib/desk/useDesk";
import type { ApprovalView } from "@/lib/desk/view";
import { m } from "./ui";

const SIZES: Array<[number, string]> = [[0.5, "½×"], [1, "1×"], [2, "2×"]];

export function ApprovalCard({ ap, a }: { ap: ApprovalView; a: DeskActions }) {
  return (
    <div className="hz-appr">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span className="hz-side" style={{ background: ap.sideBg, color: ap.sideColor }}>{ap.side}</span>
          <span style={m(13, undefined, "var(--cE6EAEE)")}>{ap.sym} · {ap.qty}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="hz-kind">{ap.kindLabel}</span>
          <span style={m(9.5, undefined, "var(--c6B7681)")}>{ap.age}</span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={m(10.5, "0.06em", ap.tint, { fontWeight: 600 })}>{ap.agent}</span>
        <span style={m(9, "0.1em", "var(--c6B7681)")}>{ap.role}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--cC9D2DA)", textWrap: "pretty" }}>{ap.why}</div>
      <div className="hz-statstrip">
        {([["LIVE PRICE", ap.px], ["NOTIONAL", ap.notional], ["% OF NAV", ap.navPct]] as const).map(([label, value]) => (
          <div key={label}>
            <div style={m(8.5, "0.14em", "var(--c5D6873)")}>{label}</div>
            <div className="hz-ellipsis" style={m(12, undefined, "var(--cE6EAEE)", { marginTop: 3, whiteSpace: "nowrap" })}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={m(9, "0.14em", "var(--c6B7681)", { marginRight: 2 })}>SIZE</span>
          {SIZES.map(([mult, label]) => (
            <button key={mult} className="hz-size" data-on={ap.mult === mult} onClick={() => a.setApprovalMult(ap.id, mult)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="hz-btn hz-btn--reject" onClick={() => a.decide(ap.id, false)}>REJECT</button>
          <button className="hz-btn hz-btn--solid" onClick={() => a.decide(ap.id, true)}>{ap.cta}</button>
        </div>
      </div>
    </div>
  );
}

export function QueueClear() {
  return (
    <div style={{ padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
      <div style={m(10, "0.18em", "var(--c98A3AD)")}>QUEUE CLEAR</div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--c6B7681)", maxWidth: 320, textWrap: "pretty" }}>
        Agents set to SUGGEST or APPROVE send their trades here. Agents on AUTO trade within risk limits.
      </div>
    </div>
  );
}
