"use client";

import { useEffect } from "react";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

function Scrim({ onClose, danger, label, children }: { onClose: () => void; danger?: boolean; label: string; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="hz-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hz-modal hz-glass" data-danger={danger} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export default function Modals({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  return (
    <>
      {s.confirmLive && (
        <Scrim danger label="Live trading" onClose={a.cancelLive}>
          <div style={m(9.5, "0.2em", "var(--cFF7A7A)")}>LIVE TRADING</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--cF2F5F7)" }}>{v.liveModal.title}</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--cA9B3BC)", textWrap: "pretty" }}>{v.liveModal.body}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
            <button className="hz-btn hz-btn--sm" onClick={a.cancelLive}>CANCEL</button>
            <button className="hz-btn hz-btn--sm hz-btn--golive" onClick={a.confirmLiveGo}>{v.liveModal.cta}</button>
          </div>
        </Scrim>
      )}
      {s.setupNotice && (
        <Scrim label="Setup" onClose={a.closeSetup}>
          <div style={m(9.5, "0.2em", "var(--cFF9E2C)")}>SETUP</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--cF2F5F7)" }}>Setup &amp; integrations</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--cA9B3BC)", textWrap: "pretty" }}>
            The six-step onboarding (runtime, model providers, market data, venues, floor and risk, launch) is the next milestone,
            with API keys held server-side rather than in this browser. Until then the desk runs on defaults:
            {" "}{v.capitalLabel} paper capital on live public prices.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button className="hz-btn hz-btn--sm hz-btn--amber" onClick={a.closeSetup}>CLOSE</button>
          </div>
        </Scrim>
      )}
    </>
  );
}
