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
      {s.liveNotice && (
        <Scrim label="Live trading" onClose={a.closeLiveNotice}>
          <div style={m(9.5, "0.2em", "var(--cFF9E2C)")}>LIVE TRADING</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--cF2F5F7)" }}>Live trading isn&apos;t available yet</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--cA9B3BC)", textWrap: "pretty" }}>
            Hermes only paper trades. Nothing in this version can place a real order, whatever you enter in Setup. The
            desk runs a simulated floor against real public prices, with simulated fills.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button className="hz-btn hz-btn--sm hz-btn--amber" onClick={a.closeLiveNotice}>GOT IT</button>
          </div>
        </Scrim>
      )}
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
    </>
  );
}
