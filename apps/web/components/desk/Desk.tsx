"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useDesk } from "@/lib/desk/useDesk";
import AgentDrawer from "./AgentDrawer";
import { ChartFull } from "./Chart";
import CentreWindow from "./CentreWindow";
import Footer from "./Footer";
import Header from "./Header";
import Mobile from "./Mobile";
import Modals from "./Modals";
import Onboarding from "./Onboarding";
import RightRail from "./RightRail";
import Roster from "./Roster";

function DeskInner() {
  const { s, view: v, actions: a } = useDesk();

  // Esc closes the agent drawer (modals handle their own Esc).
  const drawerOpen = s.sel !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.selectAgent(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, a]);

  return (
    <div className="hz-root">
      {v.isMobile ? (
        <Mobile s={s} v={v} a={a} />
      ) : (
        <>
          <Header s={s} v={v} a={a} />
          <main className="hz-main">
            <Roster v={v} a={a} />
            {s.centerOpen && <CentreWindow s={s} v={v} a={a} />}
            <RightRail s={s} v={v} a={a} />
          </main>
          <Footer s={s} v={v} a={a} />
        </>
      )}
      {s.chartFull && <ChartFull s={s} v={v} a={a} />}
      <AgentDrawer v={v} a={a} />
      <Modals s={s} v={v} a={a} />
      {s.setupNotice && <Onboarding s={s} v={v} a={a} />}
    </div>
  );
}

/**
 * The Desk renders on the client only: its initial state reads localStorage, the clock and
 * live prices, none of which exist on the server, so a server render would never hydrate cleanly.
 */
const noopSubscribe = () => () => {};

export default function Desk() {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return mounted ? <DeskInner /> : <div className="hz-root" aria-busy="true" />;
}
