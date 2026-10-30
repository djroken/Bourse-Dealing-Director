"use client";

import { useEffect, useState } from "react";
import { ALL_TOOLS, AUTONOMY, MODELS } from "@/lib/desk/data";
import { customModelOk, fetchCatalog, keyLine, type ModelCatalog } from "@/lib/desk/models";
import type { DeskActions } from "@/lib/desk/useDesk";
import type { DeskView } from "@/lib/desk/view";
import { m } from "./ui";

function Label({ children }: { children: React.ReactNode }) {
  return <div style={m(9, "0.2em", "var(--c5D6873)")}>{children}</div>;
}

/** The seed's model names are labels for the stub rule; only ids with a provider prefix call a real model. */
const STUB_LABELS = MODELS.filter((x) => !/^(ollama|openrouter|openrouter-free):/.test(x));

/**
 * Model picker. With core connected it offers what can really run: OpenRouter's free models (live list) and the models
 * installed in Ollama, plus any id typed in. Without core, the simulated floor's labels.
 */
function ModelPicker({ v, a, model }: { v: DeskView; a: DeskActions; model: string }) {
  const [cat, setCat] = useState<ModelCatalog | null>(null);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    if (!v.coreLive) return;
    let live = true;
    void fetchCatalog().then((c) => live && setCat(c));
    return () => {
      live = false;
    };
  }, [v.coreLive]);
  const known = new Set([...(cat?.free ?? []).map((x) => x.id), ...(cat?.ollama ?? []).map((x) => x.id), ...MODELS]);
  const key = keyLine(cat, model);
  const use = () => {
    const t = custom.trim();
    if (customModelOk(t)) {
      a.patchSel({ model: t.slice(0, 96) });
      setCustom("");
    }
  };
  const customBad = custom.trim() !== "" && !customModelOk(custom);
  return (
    <>
      <select className="hz-select" value={model} aria-label="Model" onChange={(e) => a.patchSel({ model: e.target.value })}>
        {!known.has(model) && <option value={model}>{model}</option>}
        {v.coreLive && cat && (
          <optgroup label={`OpenRouter · free${cat.free.length ? ` (${cat.free.length})` : cat.freeError ? " · list unavailable" : ""}`}>
            {cat.free.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {!cat.free.length && <option value="openrouter-free:meta-llama/llama-3.3-70b-instruct:free">meta-llama/llama-3.3-70b-instruct:free</option>}
          </optgroup>
        )}
        {v.coreLive && cat && cat.ollama.length > 0 && (
          <optgroup label="Ollama on this machine">
            {cat.ollama.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </optgroup>
        )}
        {(!v.coreLive || !cat) && (
          <optgroup label="Models (through core)">
            {MODELS.filter((x) => !STUB_LABELS.includes(x)).map((x) => <option key={x} value={x}>{x}</option>)}
          </optgroup>
        )}
        <optgroup label={v.coreLive ? "No model: stub rule" : "Simulated floor labels"}>
          {STUB_LABELS.map((x) => <option key={x} value={x}>{x}{v.coreLive ? " (stub rule)" : ""}</option>)}
        </optgroup>
      </select>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="hz-select" aria-label="Custom model id" spellCheck={false} autoComplete="off" value={custom}
          aria-invalid={customBad || undefined}
          placeholder="Or type an id: openrouter-free:vendor/model:free"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") use(); }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="hz-btn hz-btn--sm" disabled={!customModelOk(custom)} onClick={use}>USE</button>
      </div>
      {customBad && <div style={m(9.5, undefined, "var(--cFF7A7A)", { lineHeight: 1.5 })}>Start with ollama:, openrouter-free: or openrouter:, then the model id.</div>}
      {key && <div data-testid="model-key" data-ok={key.ok} style={m(9.5, undefined, key.ok ? "var(--c3ECF8E)" : "var(--cFFB13D)", { lineHeight: 1.5 })}>{key.text}</div>}
      {v.sel?.modelError && <div data-testid="model-error" role="status" style={m(9.5, undefined, "var(--cFF7A7A)", { lineHeight: 1.5 })}>Last call failed: {v.sel.modelError}</div>}
    </>
  );
}

export default function AgentDrawer({ v, a }: { v: DeskView; a: DeskActions }) {
  const sel = v.sel;
  if (!sel) return null;

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
          <ModelPicker v={v} a={a} model={sel.model} />
          <div style={m(9.5, undefined, "var(--c6B7681)", { lineHeight: 1.5 })}>
            ollama: runs locally and is free. openrouter-free: only accepts :free models. openrouter: takes any model and may cost money. Model seats suggest only; they never trade on their own.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {([["TOKENS TODAY", sel.tokens], ["SPEND TODAY", sel.spend], ["LAST LATENCY", sel.latency]] as const).map(([label, value]) => (
              <div key={label} style={{ flex: 1, border: "1px solid var(--w07)", borderRadius: 3, padding: "8px 10px" }}>
                <div style={m(8.5, "0.14em", "var(--c5D6873)")}>{label}</div>
                <div style={m(12.5, undefined, undefined, { marginTop: 3 })}>{value}</div>
              </div>
            ))}
          </div>
          <div style={m(9, undefined, "var(--c5D6873)", { lineHeight: 1.5 })} data-testid="usage-note">{sel.usageNote}</div>
        </div>

        {sel.track && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }} aria-label="Track record">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <Label>TRACK RECORD · PAPER</Label>
              <span style={m(9, "0.08em", "var(--c5D6873)")}>{sel.track.ideas} IDEAS · {sel.track.fills} FILLS</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {([["HIT RATE", sel.track.hit, sel.track.hitNote, undefined], ["WIN RATE", sel.track.win, sel.track.winNote, undefined], ["P&L", sel.track.pnl, "realised + open", sel.track.pnlColor], ["MAX DRAWDOWN", sel.track.dd, "from peak", "var(--cFF7A7A)"]] as const).map(([label, value, note, color]) => (
                <div key={label} style={{ border: "1px solid var(--w07)", borderRadius: 3, padding: "8px 10px" }}>
                  <div style={m(8.5, "0.14em", "var(--c5D6873)")}>{label}</div>
                  <div style={m(13, undefined, color, { marginTop: 3 })}>{value}</div>
                  <div style={m(8.5, "0.04em", "var(--c5D6873)", { marginTop: 2 })}>{note}</div>
                </div>
              ))}
            </div>
          </div>
        )}

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
