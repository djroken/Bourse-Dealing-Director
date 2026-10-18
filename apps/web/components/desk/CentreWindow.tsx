"use client";

import { useEffect, useRef, useState } from "react";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { ChatRow, DeskView } from "@/lib/desk/view";
import { ApprovalCard, QueueClear } from "./ApprovalCard";
import { m } from "./ui";

/** One floor-chat event, shared by the desktop log and the mobile chat. */
export function ChatLine({ r }: { r: ChatRow }) {
  if (r.kind === "trade") {
    return (
      <div className="hz-ticket">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span className="hz-side" style={{ background: r.sideBg, color: r.sideColor }}>{r.side}</span>
          <span style={m(12.5, undefined, "var(--cE6EAEE)")}>{r.text}</span>
        </div>
        <span style={m(9.5, undefined, "var(--c6B7681)", { flex: "none" })}>{r.who} · {r.ticket}</span>
      </div>
    );
  }
  if (r.kind === "sys") {
    return <div style={m(11, "0.08em", r.tint)}>{r.text}</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={m(10.5, "0.06em", r.tint, { fontWeight: 600 })}>{r.who}</span>
        <span style={m(9, "0.1em", "var(--c4E5862)")}>{r.role}</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--cC9D2DA)", marginTop: 3, textWrap: "pretty" }}>{r.text}</div>
    </div>
  );
}

/** Two clicks to wipe every paper book and scorecard: the first arms it, the second (within 4 s) does it. */
function ResetPaper({ a }: { a: DeskActions }) {
  const [armed, setArmed] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className="hz-btn hz-btn--sm hz-btn--warn" style={{ flex: "none" }}
      title="Start every agent's paper book and track record again from zero. Seat settings are kept."
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setFailed(false);
          return;
        }
        setArmed(false);
        void a.resetPaper().then((ok) => setFailed(!ok));
      }}
    >
      {failed ? "RESET FAILED" : armed ? "CLICK AGAIN TO RESET" : "RESET PAPER"}
    </button>
  );
}

export default function CentreWindow({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  const logRef = useRef<HTMLDivElement>(null);
  const events = s.seq.length;
  useEffect(() => {
    const el = logRef.current;
    if (el && s.tab === "chat") el.scrollTop = el.scrollHeight;
  }, [events, s.tab]);

  return (
    <section className="hz-panel hz-centre hz-glass">
      <div className="hz-panel-head hz-panel-head--tabs">
        <div className="hz-tabs" role="tablist">
          {v.tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.active} className="hz-tab" data-on={t.active} onClick={() => a.setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* The meta label gives way first (shrink weight 100), so the tabs keep their room. */}
        <div style={{ flex: "0 100 auto", minWidth: 26, marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, paddingLeft: 10 }}>
          <span className="hz-ellipsis" style={m(9.5, "0.12em", "var(--c5D6873)", { whiteSpace: "nowrap", minWidth: 0 })}>{v.centerMeta}</span>
          <button className="hz-x" aria-label="Close floor window" onClick={a.toggleCenter}>×</button>
        </div>
      </div>
      <div className="hz-sim" role="note">
        {v.strip}
      </div>

      {s.tab === "chat" && (
        <>
          <div ref={logRef} className="hz-log">
            {v.chat.map((r) => (
              <div key={r.key} style={{ display: "flex", gap: 10 }}>
                <div style={m(9.5, undefined, "var(--c4E5862)", { width: 52, flex: "none", paddingTop: 3 })}>{r.time}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <ChatLine r={r} />
                </div>
              </div>
            ))}
          </div>
          <div className="hz-composer">
            <span style={m(12, undefined, "var(--cFF9E2C)")}>›</span>
            <input
              className="hz-input"
              value={s.draft}
              aria-label="Instruct the floor"
              onChange={(e) => a.setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && a.sendDraft()}
              placeholder="Instruct the floor — e.g. flatten all perp exposure before the CPI print"
            />
            <button className="hz-btn hz-btn--send" onClick={a.sendDraft}>SEND</button>
          </div>
        </>
      )}

      {s.tab === "blotter" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <div className="hz-blotter-row hz-blotter-head hz-glass">
            <div>TIME</div><div>SIDE</div><div>INSTRUMENT</div><div>QTY</div><div>PRICE</div><div>P&amp;L</div><div>AGENT</div>
            <div style={{ textAlign: "right" }}>STATUS</div>
          </div>
          {v.fills.map((f) => (
            <div key={f.key} className="hz-blotter-row hz-blotter-body">
              <div style={{ color: "var(--c6B7681)" }}>{f.time}</div>
              <div style={{ fontWeight: 600, color: f.sideColor }}>{f.side}</div>
              <div style={{ color: "var(--cE6EAEE)" }}>{f.sym}</div>
              <div>{f.qty}</div>
              <div>{f.px}</div>
              <div style={{ color: f.pnlColor }}>{f.pnl}</div>
              <div style={{ color: "var(--c8C97A2)" }}>{f.agent}</div>
              <div style={{ textAlign: "right", fontSize: 9.5, letterSpacing: "0.1em", color: f.stColor }}>{f.status}</div>
            </div>
          ))}
        </div>
      )}

      {s.tab === "scores" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 14px", borderBottom: "1px solid var(--w05)" }}>
            <span style={m(9.5, "0.06em", "var(--c7C8894)", { lineHeight: 1.5 })}>{v.scoresNote}</span>
            {v.scores.length > 0 && <ResetPaper a={a} />}
            {v.scores.length > 0 && (
              <a className="hz-btn hz-btn--sm" href={v.exportUrl} download title="Every idea this session with what the price did next, as JSON Lines" style={{ flex: "none", textDecoration: "none" }}>
                EXPORT IDEAS
              </a>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {v.scores.length > 0 && (
              <div className="hz-score-row hz-blotter-head hz-glass">
                <div>AGENT</div><div>IDEAS</div><div>HIT RATE</div><div>AVG MOVE</div><div>FILLS</div><div>WIN RATE</div><div>P&amp;L</div><div>MAX DD</div>
                <div style={{ textAlign: "right" }}>VETOES</div>
              </div>
            )}
            {v.scores.map((r) => (
              <div key={r.key} className="hz-score-row hz-blotter-body" data-testid="score-row">
                <div style={{ minWidth: 0 }}>
                  <div className="hz-ellipsis" style={{ color: r.tint, fontWeight: 600 }}>{r.name}</div>
                  <div className="hz-ellipsis" style={m(8.5, "0.1em", "var(--c5D6873)", { marginTop: 2 })} title={r.model}>{r.sub} · {r.model}</div>
                </div>
                <div>{r.ideas}</div>
                <div style={{ color: r.hitColor }}>{r.hit}</div>
                <div style={{ color: r.avgColor }}>{r.avg}</div>
                <div>{r.fills}</div>
                <div>{r.win}</div>
                <div style={{ color: r.pnlColor }}>{r.pnl}</div>
                <div style={{ color: r.dd === "—" ? "var(--c7C8894)" : "var(--cFF7A7A)" }}>{r.dd}</div>
                <div style={{ textAlign: "right" }}>{r.vetoes}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {s.tab === "console" && (
        <div style={{ ...m(11.5), flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px", lineHeight: 1.75 }}>
          {v.logs.map((l) => (
            <div key={l.key} style={{ display: "flex", gap: 12 }}>
              <span style={{ color: "var(--c3F4750)", flex: "none" }}>{l.time}</span>
              <span style={{ flex: "none", width: 74, letterSpacing: "0.1em", color: l.tint }}>{l.level}</span>
              <span style={{ color: "var(--cA9B3BC)" }}>{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {s.tab === "approvals" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {v.approvals.map((ap) => <ApprovalCard key={ap.id} ap={ap} a={a} />)}
          {v.nAppr === 0 && <QueueClear />}
        </div>
      )}
    </section>
  );
}
