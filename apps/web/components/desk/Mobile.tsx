"use client";

import { useEffect, useRef } from "react";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState, MobileTab } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import { ApprovalCard, QueueClear } from "./ApprovalCard";
import { ChartBody, ChartToggle, ChartTools } from "./Chart";
import { GlassSlider, ThemeSwitch } from "./Footer";
import { m } from "./ui";

const TABS: Array<[MobileTab, string]> = [["floor", "FLOOR"], ["chat", "CHAT"], ["approvals", "QUEUE"], ["markets", "MARKETS"], ["more", "MORE"]];

export default function Mobile({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const events = s.seq.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && s.mTab === "chat") el.scrollTop = el.scrollHeight;
  }, [events, s.mTab]);

  const modeColor = v.isLive ? "var(--cFF8E8E)" : "var(--cFF9E2C)";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="hz-mtop hz-glass">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={m(15, "0.22em", "var(--cF2F5F7)", { fontWeight: 600 })}>BOURSE</span>
          <button className="hz-modepill" data-live={v.isLive} onClick={a.toggleMode}>{v.isLive ? "LIVE" : "DEMO"}</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
          <span style={m(14, undefined, v.pnlColor, { fontWeight: 500 })}>{v.pnlStr}</span>
          <span style={m(9, "0.12em", "var(--c6B7681)")}>NAV {v.navStr}</span>
        </div>
      </div>

      {v.isLive && (
        <div className="hz-livebanner hz-livebanner--m">
          <span className="hz-dot" style={{ background: "var(--cFF5B5B)", flex: "none" }} />
          <span className="hz-ellipsis">{v.liveBannerShort}</span>
        </div>
      )}

      <div className="hz-mtape hz-glass">
        {v.tape.map((t) => (
          <div key={t.key} className="hz-mtape-cell" data-on={t.active} onClick={() => t.sel && a.selectSym(t.sel)}>
            <div style={m(9, "0.12em", "var(--c6B7681)", { whiteSpace: "nowrap" })}>{t.sym}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
              <span style={m(12, undefined, "var(--cE6EAEE)", { fontWeight: 500 })}>{t.px}</span>
              <span style={m(9.5, undefined, t.color)}>{t.chg}</span>
            </div>
          </div>
        ))}
      </div>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {s.mTab === "floor" && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
              {v.filters.map((f) => (
                <button key={f.id} className="hz-chip hz-chip--lg" data-on={f.active} onClick={() => a.setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            {v.roster.map((c) => (
              <div key={c.idx} className="hz-mrow" role="button" tabIndex={0} onClick={() => a.selectAgent(c.idx)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && a.selectAgent(c.idx)}>
                <div className="hz-initials" style={{ width: 34, height: 34, color: c.tint }}>{c.initials}</div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div className="hz-ellipsis" style={{ fontSize: 14, fontWeight: 600, color: "var(--cEDF1F4)", whiteSpace: "nowrap" }}>{c.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span className="hz-dot" style={{ background: c.statusColor, flex: "none" }} />
                    <span className="hz-ellipsis" style={m(9, "0.08em", "var(--c6B7681)", { whiteSpace: "nowrap" })}>{c.status} · {c.role}</span>
                  </div>
                </div>
                <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                  <span style={m(13.5, undefined, c.pnlColor, { fontWeight: 500 })}>{c.pnl}</span>
                  <span className="hz-pill" data-auto={c.isAuto}>{c.autonomy}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {s.mTab === "chat" && (
          <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {v.chat.map((r) => (
                <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {r.kind === "msg" && (
                    <>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={m(10.5, "0.06em", r.tint, { fontWeight: 600 })}>{r.who}</span>
                        <span style={m(9, undefined, "var(--c4E5862)")}>{r.time}</span>
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--cC9D2DA)", textWrap: "pretty" }}>{r.text}</div>
                    </>
                  )}
                  {r.kind === "trade" && (
                    <div className="hz-ticket hz-ticket--m">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="hz-side" style={{ background: r.sideBg, color: r.sideColor }}>{r.side}</span>
                        <span style={m(12, undefined, "var(--cE6EAEE)")}>{r.text}</span>
                      </div>
                      <span style={m(9.5, undefined, "var(--c6B7681)")}>{r.who} · {r.ticket} · {r.time}</span>
                    </div>
                  )}
                  {r.kind === "sys" && <div style={m(11, "0.06em", r.tint, { lineHeight: 1.5 })}>{r.text}</div>}
                </div>
              ))}
            </div>
            <div className="hz-mcomposer hz-glass">
              <input
                className="hz-input hz-input--m" value={s.draft} placeholder="Instruct the floor" aria-label="Instruct the floor"
                onChange={(e) => a.setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && a.sendDraft()}
              />
              <button className="hz-btn hz-btn--solid hz-btn--send-m" onClick={a.sendDraft}>SEND</button>
            </div>
          </div>
        )}

        {s.mTab === "approvals" && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {v.approvals.map((ap) => <ApprovalCard key={ap.id} ap={ap} a={a} />)}
            {v.nAppr === 0 && <QueueClear />}
          </div>
        )}

        {s.mTab === "markets" && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="hz-panel hz-glass" style={{ overflow: "hidden" }}>
              <div style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", borderBottom: "1px solid var(--w07)" }}>
                <span style={m(12, "0.1em", "var(--cE6EAEE)")}>{v.chart.label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={m(12.5, undefined, v.chart.color)}>{v.chart.last}</span>
                  <ChartToggle s={s} a={a} size="lg" />
                </div>
              </div>
              <div style={{ padding: "8px 8px 0" }}>
                <ChartTools s={s} v={v} a={a} size="lg" />
              </div>
              <div style={{ height: 300, padding: 6 }}>
                {s.chartFull ? <div className="hz-chart-away">Chart is open full screen</div> : <ChartBody s={s} v={v} grid={false} />}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderTop: "1px solid var(--w07)" }}>
                {([["NET POS", v.chart.netPos, "var(--cE6EAEE)"], ["FUNDING", v.chart.funding, "var(--cFFB13D)"], ["VOL 24H", v.chart.vol, "var(--cB4BEC7)"]] as const).map(([label, value, color]) => (
                  <div key={label} style={{ padding: "9px 12px" }}>
                    <div style={m(8.5, "0.14em", "var(--c5D6873)")}>{label}</div>
                    <div style={m(12.5, undefined, color, { marginTop: 3 })}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={m(9.5, "0.18em", "var(--c98A3AD)", { padding: "6px 2px 0" })}>AGENT SCORECARDS · PAPER</div>
            {v.scores.length === 0 && <div style={m(10, "0.04em", "var(--c6B7681)", { padding: "0 2px", lineHeight: 1.5 })}>{v.scoresNote}</div>}
            {v.scores.map((r) => (
              <div key={r.key} className="hz-mfill" data-testid="mobile-score">
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <span className="hz-ellipsis" style={{ fontSize: 13.5, fontWeight: 600, color: r.tint }}>{r.name}</span>
                  <span className="hz-ellipsis" style={m(9.5, undefined, "var(--c6B7681)", { whiteSpace: "nowrap" })}>
                    HIT <span style={{ color: r.hitColor }}>{r.hit}</span> · WIN {r.win} · DD {r.dd}
                  </span>
                </div>
                <span style={m(12.5, undefined, r.pnlColor, { flex: "none" })}>{r.pnl}</span>
              </div>
            ))}
            <div style={m(9.5, "0.18em", "var(--c98A3AD)", { padding: "6px 2px 0" })}>RECENT FILLS</div>
            {v.fills.slice(0, 8).map((f) => (
              <div key={f.key} className="hz-mfill">
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={m(10, undefined, f.sideColor, { fontWeight: 600 })}>{f.side}</span>
                    <span style={m(12, undefined, "var(--cE6EAEE)", { whiteSpace: "nowrap" })}>{f.sym} {f.qty}</span>
                  </div>
                  <span className="hz-ellipsis" style={m(9.5, undefined, "var(--c6B7681)", { whiteSpace: "nowrap" })}>{f.time} · {f.agent} · @ {f.px}</span>
                </div>
                <span style={m(12.5, undefined, f.pnlColor, { flex: "none" })}>{f.pnl}</span>
              </div>
            ))}
          </div>
        )}

        {s.mTab === "more" && (
          <div style={{ padding: "16px 14px 24px", display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={m(9.5, "0.18em", "var(--c6B7681)")}>APPEARANCE</div>
              <ThemeSwitch s={s} a={a} variant="grid" />
              {v.resolved === "glass" && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 2px" }}>
                  <span style={m(9.5, "0.14em", "var(--c98A3AD)", { flex: "none" })}>GLASS</span>
                  <GlassSlider v={v} a={a} width="100%" />
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={m(9.5, "0.18em", "var(--c6B7681)")}>DESK</div>
              <button className="hz-mmenu" onClick={a.openSetup}>
                <span>Setup &amp; integrations</span>
                <span style={m(12, undefined, "var(--c6B7681)")}>›</span>
              </button>
              <button className="hz-mmenu" onClick={a.toggleMode}>
                <span>Trading mode</span>
                <span style={m(11, "0.12em", modeColor)}>{v.isLive ? "LIVE" : "DEMO"}</span>
              </button>
              <button className="hz-mmenu hz-mmenu--halt" onClick={a.toggleHalt}>{s.halted ? "RESUME" : "HALT ALL"}</button>
            </div>
            <div className="hz-mstatus">
              {[v.feedLabel, v.runtimeLabel, v.modeLabel].map((t) => <div key={t}>{t}</div>)}
            </div>
          </div>
        )}
      </div>

      <nav className="hz-mnav hz-glass" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button key={id} className="hz-mnav-btn" data-on={s.mTab === id} onClick={() => a.setMTab(id)}>
            <span>{label}</span>
            {id === "approvals" && v.nAppr > 0 && <span className="hz-badge">{v.nAppr}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
