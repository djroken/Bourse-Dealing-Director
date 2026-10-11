"use client";

import { THEME_LIST } from "@/lib/desk/theme";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";

export function ThemeSwitch({ s, a, variant = "footer" }: { s: DeskState; a: DeskActions; variant?: "footer" | "grid" }) {
  return (
    <div className={variant === "grid" ? "hz-themegrid" : "hz-seg hz-seg--theme"} role="group" aria-label="Theme">
      {THEME_LIST.map(([id, label, title]) => (
        <button key={id} title={title} data-on={s.theme === id} onClick={() => a.setTheme(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function GlassSlider({ v, a, width = 70 }: { v: DeskView; a: DeskActions; width?: number | string }) {
  if (v.resolved !== "glass") return null;
  return (
    <div title="Glass panel opacity" style={{ flex: "none", display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="range" min={10} max={95} step={1} value={v.glassPct} aria-label="Glass opacity"
        onChange={(e) => a.setGlass(Number(e.target.value))}
        style={{ width, height: 14, margin: 0, accentColor: "#FF9E2C", cursor: "pointer" }}
      />
      <span style={{ width: 28, textAlign: "right", color: "var(--c98A3AD)" }}>{v.glassPct}%</span>
    </div>
  );
}

export default function Footer({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  return (
    <footer className="hz-footer hz-glass">
      <div className="hz-fcell" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="hz-dot" style={{ background: v.engineColor }} />
        <span style={{ letterSpacing: "0.12em", color: v.engineColor }}>{v.engineState}</span>
      </div>
      <div className="hz-fcell" style={{ letterSpacing: "0.08em" }}>{v.feedLabel}</div>
      <div className="hz-fcell" style={{ letterSpacing: "0.08em" }}>{v.runtimeLabel}</div>
      <div className="hz-ellipsis" style={{ flex: 1, minWidth: 60, padding: "0 14px", whiteSpace: "nowrap", color: "var(--c8C97A2)" }}>{v.lastFill}</div>
      <div className="hz-fcell hz-fcell--l" style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
        <ThemeSwitch s={s} a={a} />
        <GlassSlider v={v} a={a} />
      </div>
      <div style={{ flex: "none", padding: "0 14px", letterSpacing: "0.12em", color: "var(--c4E5862)", whiteSpace: "nowrap" }}>{v.modeLabel}</div>
    </footer>
  );
}
