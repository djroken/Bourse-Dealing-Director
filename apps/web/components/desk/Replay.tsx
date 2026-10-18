"use client";

import { useEffect, useState } from "react";
import type { DeskState } from "@/lib/desk/state";
import {
  DEFAULT_FORM, REPLAY_DAYS, REPLAY_SYMBOLS, REPLAY_TFS, TRADING_ROLES, cancelReplay, candlesFor, getReplay, horizonLabel, replayView,
  startReplay, type ReplayForm, type ReplayJob,
} from "@/lib/desk/replay";
import { m } from "./ui";

const norm = (r: string) => r.toUpperCase().replace(/\s+/g, " ").trim();
const HORIZONS = [1, 3, 6, 12, 24];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={m(8.5, "0.16em", "var(--c5D6873)")}>{label}</div>
      {children}
    </div>
  );
}

function Seg<T extends string | number>({ label, options, value, onChange, show = String }: { label: string; options: readonly T[]; value: T; onChange: (v: T) => void; show?: (v: T) => string }) {
  return (
    <div className="hz-seg hz-seg--chart" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o)} data-on={o === value} aria-pressed={o === value} onClick={() => onChange(o)}>{show(o)}</button>
      ))}
    </div>
  );
}

/** Run the trading seats over past candles and score every idea. Lives in core; this tab drives it. */
export default function Replay({ s }: { s: DeskState }) {
  const [form, setForm] = useState<ReplayForm>(DEFAULT_FORM);
  const [job, setJob] = useState<ReplayJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const core = s.core === "live";
  const busy = !!job && (job.status === "fetching" || job.status === "running");

  // Show the last replay core has (survives a page reload), then poll while one is running.
  useEffect(() => {
    if (!core) return;
    let stop = false;
    void getReplay().then((j) => !stop && j && setJob(j));
    return () => {
      stop = true;
    };
  }, [core]);
  const jobId = job?.id;
  useEffect(() => {
    if (!busy || !jobId) return;
    const t = setInterval(() => void getReplay(jobId).then((j) => j && setJob(j)), 1000);
    return () => clearInterval(t);
  }, [busy, jobId]);

  const v = replayView(job);
  const set = (p: Partial<ReplayForm>) => setForm((f) => ({ ...f, ...p }));
  const modelOf = (role: string) => s.agents.find((a) => norm(a.role) === norm(role))?.model ?? "";
  const nameOf = (role: string) => s.agents.find((a) => norm(a.role) === norm(role))?.name ?? role;
  const n = candlesFor(form.timeframe, form.days);
  const modelSeats = form.roles.filter((r) => /^(ollama|openrouter|openrouter-free):/.test(modelOf(r))).length;

  if (!core) {
    return (
      <div style={m(11, "0.04em", "var(--c7C8894)", { padding: 18, lineHeight: 1.6 })}>
        Replay runs inside Bourse Core. Start it with <span style={{ color: "var(--cE6EAEE)" }}>pnpm dev</span> and come back to this tab to test agents on past candles.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={m(10, "0.04em", "var(--c7C8894)", { lineHeight: 1.6 })}>
        Run the trading seats over past candles with their current model and mandate. Each idea is scored on the close a fixed number of candles later and booked as a paper trade, after fees. The agents only ever see candles up to the moment they decide.
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <Field label="SYMBOL"><Seg label="Replay symbol" options={REPLAY_SYMBOLS} value={form.symbol} onChange={(symbol) => set({ symbol })} show={(x) => x.replace("-", "/")} /></Field>
        <Field label="CANDLES"><Seg label="Replay timeframe" options={REPLAY_TFS} value={form.timeframe} onChange={(timeframe) => set({ timeframe })} show={(x) => x.toUpperCase()} /></Field>
        <Field label="PERIOD"><Seg label="Replay period" options={REPLAY_DAYS} value={form.days} onChange={(days) => set({ days })} show={(d) => `${d}D`} /></Field>
        <Field label="SCORE AFTER"><Seg label="Replay horizon" options={HORIZONS} value={form.horizon} onChange={(horizon) => set({ horizon })} show={(h) => horizonLabel(form.timeframe, h)} /></Field>
      </div>

      <Field label="SEATS">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TRADING_ROLES.map((role) => {
            const on = form.roles.includes(role);
            return (
              <button
                key={role} className="hz-chip" style={{ height: 26, letterSpacing: "0.06em" }} data-on={on} aria-pressed={on} title={modelOf(role)}
                onClick={() => set({ roles: on ? form.roles.filter((r) => r !== role) : form.roles.concat([role]) })}
              >
                {nameOf(role)} · {/^(ollama|openrouter|openrouter-free):/.test(modelOf(role)) ? modelOf(role) : "stub rule"}
              </button>
            );
          })}
        </div>
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          className="hz-btn hz-btn--sm hz-btn--amber" disabled={busy || form.roles.length === 0}
          onClick={() => {
            setErr(null);
            void startReplay(form).then((r) => (r.ok ? setJob(r.value) : setErr(r.error)));
          }}
        >
          RUN REPLAY
        </button>
        {busy && job && (
          <button className="hz-btn hz-btn--sm hz-btn--warn" onClick={() => void cancelReplay(job.id)}>CANCEL</button>
        )}
        <span style={m(9.5, "0.04em", "var(--c6B7681)")}>
          {n.toLocaleString("en-US")} candles per seat
          {modelSeats > 0 ? ` · model seats sampled to ${form.maxModelCalls} calls each (uses your daily model cap; OpenRouter paid models cost money)` : ""}
        </span>
      </div>

      {err && <div role="alert" style={m(11, undefined, "var(--cFF7A7A)")}>{err}</div>}

      {v && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={m(10, "0.12em", v.error ? "var(--cFF7A7A)" : "var(--cFF9E2C)")} data-testid="replay-status">{v.statusLine.toUpperCase()}</span>
            <div style={{ flex: 1 }} />
            {v.exportUrl && (
              <a className="hz-btn hz-btn--sm" href={v.exportUrl} download style={{ textDecoration: "none" }} title="Every replayed idea and its outcome, as JSON Lines">EXPORT IDEAS</a>
            )}
          </div>
          {v.busy && (
            <div style={{ height: 3, background: "var(--w07)", borderRadius: 2, overflow: "hidden" }} role="progressbar" aria-valuenow={v.progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ height: "100%", width: `${v.progressPct}%`, background: "var(--cFF9E2C)", transition: "width .4s" }} />
            </div>
          )}
          {v.error && <div style={m(11, undefined, "var(--cFF7A7A)")}>{v.error}</div>}
          {v.summary && <div style={m(9.5, "0.04em", "var(--c7C8894)", { lineHeight: 1.6 })}>{v.summary}</div>}
          {v.rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <div className="hz-replay-row hz-blotter-head">
                <div>SEAT</div><div>IDEAS</div><div>HIT RATE</div><div>AVG MOVE</div><div>WIN RATE</div><div>P&amp;L</div><div>MAX DD</div><div style={{ textAlign: "right" }}>FAILED</div>
              </div>
              {v.rows.map((r) => (
                <div key={r.key} className="hz-replay-row hz-blotter-body" data-testid="replay-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="hz-ellipsis" style={{ color: "var(--cE6EAEE)", fontWeight: 600 }}>{r.name}</div>
                    <div className="hz-ellipsis" style={m(8.5, "0.1em", "var(--c5D6873)", { marginTop: 2 })} title={r.model}>{r.role} · {r.model}</div>
                  </div>
                  <div>{r.ideas}</div>
                  <div style={{ color: r.hitColor }}>{r.hit}</div>
                  <div style={{ color: r.avgColor }}>{r.avg}</div>
                  <div>{r.win}</div>
                  <div style={{ color: r.pnlColor }}>{r.pnl}</div>
                  <div style={{ color: r.dd === "—" ? "var(--c7C8894)" : "var(--cFF7A7A)" }}>{r.dd}</div>
                  <div style={{ textAlign: "right", color: r.failedColor }}>{r.failed}</div>
                </div>
              ))}
            </div>
          )}
          {v.rows.length > 0 && (
            <div style={m(9, "0.04em", "var(--c5D6873)", { lineHeight: 1.5 })}>
              Past results on paper. Fixed-horizon trades sized like live intents, fees included, no slippage. Not a forecast and not financial advice.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
