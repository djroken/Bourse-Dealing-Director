"use client";

import { ALL_TOOLS, AUTONOMY, MODELS } from "@/lib/desk/data";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

function Label({ children }: { children: React.ReactNode }) {
  return <div style={m(9, "0.2em", "var(--c5D6873)")}>{children}</div>;
}

export default function AgentDrawer({ v, a }: { v: DeskView; a: DeskActions }) {
  const sel = v.sel;
  if (!sel) return null;
  // Keep a custom/unknown model selectable instead of silently snapping to the first option.
  const models = MODELS.includes(sel.model) ? MODELS : [sel.model, ...MODELS];

  return (
    <aside
      className="hz-drawer hz-glass"
      data-live={v.isLive}
      data-mobile={v.isMobile}
      role="dialog"
      aria-label={`${sel.name} settings`}
    >
      <div style={{ flex: "none", padding: "13px 14px", borderBottom: "1px solid var(--w07)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", gap: 11, minWidth: 0 }}>
          <div className="hz-initials" style={{ width: 34, height: 34, fontSize: 12, color: sel.tint }}>{sel.initials}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{sel.name}</div>
            <div style={m(9.5, "0.12em", "var(--c6B7681)", { marginTop: 3 })}>{sel.role}</div>
          </div>
        </div>
        <button className="hz-x" aria-label="Close settings" onClick={() => a.selectAgent(null)}>×</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Label>MODEL</Label>
          <select className="hz-select" value={sel.model} aria-label="Model" onChange={(e) => a.patchSel({ model: e.target.value })}>
            {models.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
          </select>
          <input
            key={sel.model} className="hz-select" aria-label="Custom model id" spellCheck={false} autoComplete="off"
            placeholder="Custom id: ollama:qwen3 · openrouter:vendor/model"
            onKeyDown={(e) => { if (e.key === "Enter") { const t = e.currentTarget.value.trim(); if (t) a.patchSel({ model: t.slice(0, 96) }); } }}
            onBlur={(e) => { const t = e.currentTarget.value.trim(); if (t) a.patchSel({ model: t.slice(0, 96) }); }}
          />
          <div style={m(9.5, undefined, "var(--c6B7681)", { lineHeight: 1.5 })}>
            ollama: runs locally and is free. openrouter-free: only accepts :free models. openrouter: takes any model and may cost money. Model seats suggest only; they never trade on their own.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {([["TOKENS 24H", sel.tokens], ["SPEND 24H", sel.spend], ["LATENCY", sel.latency]] as const).map(([label, value]) => (
              <div key={label} style={{ flex: 1, border: "1px solid var(--w07)", borderRadius: 3, padding: "8px 10px" }}>
                <div style={m(8.5, "0.14em", "var(--c5D6873)")}>{label}</div>
                <div style={m(12.5, undefined, undefined, { marginTop: 3 })}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Label>REASONING TEMPERATURE</Label>
            <div style={m(11.5, undefined, "var(--cFF9E2C)")}>{sel.temp.toFixed(2)}</div>
          </div>
          <input
            type="range" min={0} max={1} step={0.05} value={sel.temp} aria-label="Reasoning temperature"
            onChange={(e) => a.patchSel({ temp: Number(e.target.value) })}
            style={{ width: "100%", accentColor: "var(--cFF9E2C)" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Label>AUTONOMY</Label>
          <div style={{ display: "flex", gap: 6 }}>
            {AUTONOMY.map((o) => (
              <button key={o} className="hz-auto" data-on={sel.autonomy === o} onClick={() => a.patchSel({ autonomy: o })}>{o}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Label>MANDATE</Label>
          <textarea
            className="hz-textarea" rows={4} value={sel.mandate} aria-label="Mandate (system prompt)"
            onChange={(e) => a.patchSel({ mandate: e.target.value })}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Label>RISK LIMITS</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {([["Max clip size", sel.maxClip, undefined], ["Max leverage", sel.leverage, undefined], ["Daily loss stop", sel.lossStop, "var(--cFF7A7A)"]] as const).map(([label, value, color]) => (
              <div key={label} className="hz-limit">
                <span style={{ fontSize: 12.5, color: "var(--cA9B3BC)" }}>{label}</span>
                <span style={m(12, undefined, color)}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Label>TOOLS &amp; FEEDS</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ALL_TOOLS.map((t) => {
              const on = sel.tools.includes(t);
              return (
                <button
                  key={t} className="hz-toolchip" data-on={on} aria-pressed={on}
                  onClick={() => a.patchSel({ tools: on ? sel.tools.filter((x) => x !== t) : sel.tools.concat([t]) })}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ flex: "none", padding: "11px 14px", borderTop: "1px solid var(--w07)", display: "flex", gap: 8 }}>
        <button className="hz-btn hz-btn--sm" title="Restore this agent's default model, mandate and limits" onClick={a.resetSel}>RESET</button>
        <button className="hz-btn hz-btn--sm hz-btn--warn" style={{ flex: 1 }} onClick={a.pauseSel}>
          {sel.paused ? "RESUME AGENT" : "PAUSE AGENT"}
        </button>
        <button className="hz-btn hz-btn--sm hz-btn--amber" style={{ flex: 1, justifyContent: "center" }} onClick={() => a.selectAgent(null)}>APPLY</button>
      </div>
    </aside>
  );
}
