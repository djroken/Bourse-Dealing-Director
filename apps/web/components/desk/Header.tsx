"use client";

import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

interface Props {
  s: DeskState;
  v: DeskView;
  a: DeskActions;
}

export default function Header({ s, v, a }: Props) {
  const queued = v.nAppr > 0;
  return (
    <>
      <header className="hz-header hz-glass">
        <div className="hz-brand">
          <div style={m(16, "0.24em", "var(--cF2F5F7)", { fontWeight: 600 })}>HERMES</div>
          <div style={m(8.5, "0.2em", "var(--c6B7681)", { marginTop: 2 })}>AGENTIC TRADING FLOOR</div>
        </div>

        <div className="hz-tape" role="list" aria-label="Instruments">
          {v.tape.map((t) => (
            <div
              key={t.key}
              role="listitem"
              className="hz-tape-cell"
              data-on={t.active}
              data-inert={t.sel === null}
              onClick={() => t.sel && a.selectSym(t.sel)}
            >
              <div style={m(9.5, "0.14em", "var(--c6B7681)", { whiteSpace: "nowrap" })}>{t.sym}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={m(13, undefined, "var(--cE6EAEE)", { fontWeight: 500 })}>{t.px}</span>
                <span style={m(10.5, undefined, t.color)}>{t.chg}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="hz-hright">
          <div className="hz-stat">
            <div style={m(8.5, "0.16em", "var(--c6B7681)")}>BOOK NAV</div>
            <div style={m(14, undefined, undefined, { fontWeight: 500 })}>{v.navStr}</div>
          </div>
          <div className="hz-stat">
            <div style={m(8.5, "0.16em", "var(--c6B7681)")}>SESSION P&amp;L</div>
            <div style={m(14, undefined, v.pnlColor, { fontWeight: 500 })}>{v.pnlStr}</div>
          </div>
          <div style={{ width: 1, height: 28, background: "var(--w08)", flex: "none" }} />
          <div style={m(12, "0.06em", "var(--c98A3AD)", { flex: "none", whiteSpace: "nowrap" })}>{v.clock}</div>

          <div className="hz-seg hz-seg--mode" role="group" aria-label="Trading mode">
            <button data-on={!v.isLive} onClick={a.setDemo}>DEMO</button>
            <button data-on={v.isLive} data-kind="live" onClick={a.requestLive}>LIVE</button>
          </div>
          <button className="hz-btn" onClick={a.openSetup}>SETUP</button>
          <button
            className="hz-btn hz-btn--queue"
            data-active={queued}
            title="Trades waiting for your approval"
            onClick={a.openQueue}
          >
            QUEUE {v.nAppr}
          </button>
          <button className="hz-btn hz-btn--amber" onClick={a.toggleCenter}>
            <span className="hz-dot" style={{ background: "var(--cFF9E2C)" }} />
            <span>{s.centerOpen ? "FLOOR OPEN" : "OPEN FLOOR"}</span>
          </button>
          <button className="hz-btn hz-btn--red" onClick={a.toggleHalt}>
            {s.halted ? "RESUME" : "HALT ALL"}
          </button>
        </div>
      </header>

      {v.isLive && (
        <div className="hz-livebanner">
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            <span className="hz-dot hz-pulse-live" style={{ background: "var(--cFF5B5B)", flex: "none" }} />
            <span className="hz-ellipsis">{v.liveBanner}</span>
          </div>
          <button className="hz-btn hz-btn--tiny" onClick={a.setDemo}>BACK TO DEMO</button>
        </div>
      )}
    </>
  );
}
