"use client";

import { useEffect, useState } from "react";
import { AUTONOMY, AUTO_DESC, RUNTIME_NAMES } from "@/lib/desk/data";
import {
  MCP_SNIPPET, MCP_TOOLS, REVIEW_STEP, RISK_STEP, STEPS, STEP_COUNT, STEP_RAIL,
  type OnbItem, type OnbStep, keyOf, valKey,
} from "@/lib/desk/onboarding";
import { venuesReady, type DeskState } from "@/lib/desk/state";
import type { DeskView } from "@/lib/desk/view";
import type { DeskActions } from "@/lib/desk/useDesk";
import { ThemeSwitch } from "./Footer";
import { m } from "./ui";

function tagKind(tag: string): "free" | "default" | "other" {
  if (/FREE|LOCAL/.test(tag)) return "free";
  return tag === "DEFAULT" ? "default" : "other";
}

function Check({ on, radio }: { on: boolean; radio?: boolean }) {
  return (
    <span className="hz-onb-check" data-on={on} data-radio={radio}>
      {on && !radio && (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function ItemCard({ st, it, s, a }: { st: OnbStep; it: OnbItem; s: DeskState; a: DeskActions }) {
  const on = st.single ? s.setup.runtime === it.id : it.locked || !!s.setup.on[keyOf(st, it)];
  const toggle = () =>
    a.updSetup((su) => {
      if (st.single) su.runtime = it.id;
      else if (!it.locked) su.on[keyOf(st, it)] = !su.on[keyOf(st, it)];
    });
  const kind = tagKind(it.tag);
  return (
    <div
      className="hz-onb-card"
      data-on={on}
      role={st.single ? "radio" : "checkbox"}
      aria-checked={on}
      aria-disabled={it.locked || undefined}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="hz-onb-card-top">
        <Check on={on} radio={st.single} />
        <span className="hz-onb-name">{it.name}</span>
        <span className="hz-onb-tag" data-kind={kind}>{it.tag}</span>
      </div>
      <div className="hz-onb-desc">{it.desc}</div>
      {on && it.fields.length > 0 && (
        <div className="hz-onb-fields" onClick={(e) => e.stopPropagation()}>
          {it.fields.map((f) => {
            const k = valKey(st, it, f);
            const cur = s.setup.vals[k];
            return (
              <label key={f.k} className="hz-onb-field">
                <span style={m(8.5, "0.14em", "var(--c6B7681)")}>{f.label}</span>
                <input
                  className="hz-input"
                  type={f.type}
                  placeholder={f.ph}
                  readOnly={f.ro}
                  autoComplete="off"
                  spellCheck={false}
                  value={cur !== undefined ? cur : f.v || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    a.updSetup((su) => {
                      su.vals[k] = val;
                    });
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function McpBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="hz-onb-mcp">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--cF2F5F7)" }}>Plug Hermes into your agent</div>
        <button
          className="hz-btn hz-btn--sm"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            void navigator.clipboard?.writeText(MCP_SNIPPET).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--c98A3AD)" }}>
        Target config for any MCP client. The Hermes MCP server is not built yet, so this shows the interface it will expose.
      </div>
      <pre className="hz-onb-code">{MCP_SNIPPET}</pre>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {MCP_TOOLS.map((t) => (
          <span key={t} className="hz-toolchip" data-on="true" style={{ cursor: "default" }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function RiskStep({ s, a }: { s: DeskState; a: DeskActions }) {
  const risk: Array<["capital" | "lossStop" | "lev", string]> = [
    ["capital", "PAPER CAPITAL (USD)"], ["lossStop", "DAILY LOSS STOP (USD)"], ["lev", "MAX LEVERAGE (X)"],
  ];
  return (
    <>
      <div style={m(9.5, "0.16em", "var(--c6B7681)")}>AGENTS ON THE FLOOR</div>
      <div className="hz-onb-grid">
        {s.agents.map((ag, i) => {
          const on = s.setup.agentsOn[i] !== false;
          return (
            <div
              key={ag.name}
              className="hz-onb-card"
              data-on={on}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onClick={() => a.updSetup((su) => { su.agentsOn[i] = su.agentsOn[i] === false; })}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  a.updSetup((su) => { su.agentsOn[i] = su.agentsOn[i] === false; });
                }
              }}
            >
              <div className="hz-onb-card-top">
                <Check on={on} />
                <span className="hz-onb-name">{ag.name}</span>
              </div>
              <div style={m(9, "0.1em", "var(--c7C8894)")}>{ag.role.toUpperCase()}</div>
              <div style={m(9, undefined, "var(--c4E5862)")}>{ag.model}</div>
            </div>
          );
        })}
      </div>
      <div style={{ ...m(9.5, "0.16em", "var(--c6B7681)"), marginTop: 22 }}>DEFAULT AUTONOMY</div>
      <div className="hz-onb-grid" role="radiogroup" aria-label="Default autonomy">
        {AUTONOMY.map((o) => (
          <button
            key={o}
            className="hz-onb-card hz-onb-auto"
            data-on={s.setup.autonomy === o}
            role="radio"
            aria-checked={s.setup.autonomy === o}
            onClick={() => a.updSetup((su) => { su.autonomy = o; })}
          >
            <span style={m(11, "0.14em", s.setup.autonomy === o ? "var(--cFF9E2C)" : "var(--cC9D2DA)", { fontWeight: 600 })}>{o}</span>
            <span className="hz-onb-desc">{AUTO_DESC[o]}</span>
          </button>
        ))}
      </div>
      <div style={{ ...m(9.5, "0.16em", "var(--c6B7681)"), marginTop: 22 }}>RISK BUDGET</div>
      <div className="hz-onb-grid">
        {risk.map(([k, label]) => (
          <label key={k} className="hz-onb-field">
            <span style={m(8.5, "0.14em", "var(--c6B7681)")}>{label}</span>
            <input
              className="hz-input"
              inputMode="decimal"
              value={s.setup[k]}
              onChange={(e) => {
                const val = e.target.value;
                a.updSetup((su) => { su[k] = val; });
              }}
            />
          </label>
        ))}
      </div>
    </>
  );
}

function ReviewStep({ s, v }: { s: DeskState; v: DeskView }) {
  const namesOn = (i: number) => STEPS[i].items.filter((it) => it.locked || s.setup.on[keyOf(STEPS[i], it)]).map((it) => it.name);
  const models = namesOn(1);
  const feeds = namesOn(2);
  const ready = venuesReady(s.setup);
  const seats = s.setup.agentsOn.filter((x) => x !== false).length;
  const rows: Array<[string, string, boolean]> = [
    ["Agent runtime", RUNTIME_NAMES[s.setup.runtime] ?? "Hermes native", true],
    ["Model providers", models.length ? models.join(", ") : "None. Add one to run agents", models.length > 0],
    ["Market data", feeds.length + " feeds · " + feeds.slice(0, 3).join(", ") + (feeds.length > 3 ? " …" : ""), true],
    ["Live venues", ready.length ? ready.map((r) => r.name).join(", ") : "None yet · Demo only", ready.length > 0],
    ["Floor", seats + " of " + s.agents.length + " seats · default autonomy " + s.setup.autonomy, seats > 0],
    ["Risk", v.capitalLabel + " paper capital · daily loss stop $" + s.setup.lossStop + " · max " + s.setup.lev + "x", true],
  ];
  return (
    <div className="hz-onb-summary">
      {rows.map(([label, value, good]) => (
        <div key={label} className="hz-onb-sumrow">
          <span style={m(9.5, "0.14em", "var(--c6B7681)")}>{label.toUpperCase()}</span>
          <span style={{ fontSize: 13, color: good ? "var(--cE6EAEE)" : "var(--cFF7A7A)" }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Onboarding({ s, v, a }: { s: DeskState; v: DeskView; a: DeskActions }) {
  const step = Math.min(Math.max(s.onbStep, 0), STEP_COUNT - 1);
  const [confirmReset, setConfirmReset] = useState(false);
  const mobile = v.isMobile;
  const ready = venuesReady(s.setup);
  const info = step < STEPS.length ? STEPS[step] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") a.closeSetup();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);

  const title = info ? info.title : step === RISK_STEP ? "Set up the floor and risk" : "Review and launch";
  const desc = info
    ? info.desc
    : step === RISK_STEP
      ? "Choose which seats are staffed, how much freedom agents get by default, and the budget they trade inside. Hard limits are enforced by the risk engine, not by the agents."
      : "Check the setup. You can come back from SETUP at any time. Demo runs on paper against live prices; Live needs a connected venue and a confirmation.";

  return (
    <div className="hz-onb hz-glass" role="dialog" aria-modal="true" aria-label="Setup">
      <header className="hz-onb-top">
        <div style={m(15, "0.24em", "var(--cF2F5F7)", { fontWeight: 600 })}>HERMES</div>
        {!mobile && <div style={m(9, "0.2em", "var(--c6B7681)")}>SETUP</div>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {!mobile && <ThemeSwitch s={s} a={a} />}
          <button className="hz-btn hz-btn--sm" onClick={a.closeSetup}>{mobile ? "SKIP" : "SKIP · OPEN DEMO DESK"}</button>
        </div>
      </header>
      <div className="hz-onb-body">
        {!mobile && (
          <nav className="hz-onb-rail" aria-label="Setup steps">
            {STEP_RAIL.map((r, i) => (
              <button key={r.num} className="hz-onb-rail-item" data-active={i === step} data-done={i < step} onClick={() => a.setOnbStep(i)}>
                <span className="hz-onb-rail-num">{i < step ? "✓" : r.num}</span>
                <span>
                  <span className="hz-onb-rail-label">{r.label}</span>
                  <span className="hz-onb-rail-sub">{r.sub}</span>
                </span>
              </button>
            ))}
            <div style={{ marginTop: "auto", padding: "14px 16px" }}>
              {confirmReset ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button className="hz-btn hz-btn--sm hz-btn--red" onClick={() => { a.resetSetup(); setConfirmReset(false); }}>CONFIRM RESET</button>
                  <button className="hz-btn hz-btn--sm" onClick={() => setConfirmReset(false)}>CANCEL</button>
                </div>
              ) : (
                <button className="hz-btn hz-btn--sm" onClick={() => setConfirmReset(true)}>RESET TO DEFAULTS</button>
              )}
            </div>
          </nav>
        )}
        <main className="hz-onb-content" data-mobile={mobile}>
          <div className="hz-onb-inner">
            <div style={m(9.5, "0.2em", "var(--cFF9E2C)")}>STEP {String(step + 1).padStart(2, "0")} OF 0{STEP_COUNT}</div>
            <h1 className="hz-onb-title">{title}</h1>
            <p className="hz-onb-lead">{desc}</p>
            {info && (
              <div className="hz-onb-grid" role={info.single ? "radiogroup" : "group"} aria-label={info.title}>
                {info.items.map((it) => <ItemCard key={it.id} st={info} it={it} s={s} a={a} />)}
              </div>
            )}
            {info?.id === "runtime" && <McpBlock />}
            {step === RISK_STEP && <RiskStep s={s} a={a} />}
            {step === REVIEW_STEP && <ReviewStep s={s} v={v} />}
          </div>
        </main>
      </div>
      <footer className="hz-onb-foot">
        <button className="hz-btn" disabled={step === 0} onClick={() => a.setOnbStep(step - 1)}>BACK</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          {step === REVIEW_STEP ? (
            <>
              <button className="hz-btn hz-btn--red" disabled={ready.length === 0} onClick={() => a.launch(true)}>
                {ready.length ? "LAUNCH LIVE" : "LIVE NEEDS A VENUE"}
              </button>
              <button className="hz-btn hz-btn--solid" onClick={() => a.launch(false)}>LAUNCH DEMO DESK</button>
            </>
          ) : (
            <button className="hz-btn hz-btn--solid" onClick={() => a.setOnbStep(step + 1)}>CONTINUE</button>
          )}
        </div>
      </footer>
    </div>
  );
}
