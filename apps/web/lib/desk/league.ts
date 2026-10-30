"use client";

import { useEffect, useState } from "react";
import { CORE_URL } from "./secrets";

/**
 * Core's model league (GET /league): every scored idea ever, grouped by model. Untrusted input, checked field by
 * field; formatting lives here so the component only lays it out.
 */

export interface LeagueRow {
  model: string; ideas: number; hits: number; hitRate: number; avgReturnPct: number; seats: string[]; firstAt: number; lastAt: number;
}
export interface League {
  rows: LeagueRow[];
  scored: number;
  source: "log+session" | "session";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseLeague(raw: unknown): League | null {
  if (!isObj(raw) || !Array.isArray(raw.rows) || !num(raw.scored)) return null;
  const rows: LeagueRow[] = [];
  for (const r of raw.rows.slice(0, 50)) {
    if (!isObj(r) || typeof r.model !== "string" || r.model.length > 96) continue;
    if (![r.ideas, r.hits, r.hitRate, r.avgReturnPct, r.firstAt, r.lastAt].every(num)) continue;
    const seats = Array.isArray(r.seats) ? r.seats.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 12) : [];
    rows.push({ model: r.model, ideas: r.ideas as number, hits: r.hits as number, hitRate: r.hitRate as number, avgReturnPct: r.avgReturnPct as number, seats, firstAt: r.firstAt as number, lastAt: r.lastAt as number });
  }
  return { rows, scored: raw.scored, source: raw.source === "session" ? "session" : "log+session" };
}

export async function fetchLeague(f: typeof fetch = fetch, base: string = CORE_URL): Promise<League | null> {
  try {
    const r = await f(`${base}/league`);
    return r.ok ? parseLeague(await r.json()) : null;
  } catch {
    return null;
  }
}

const UP = "var(--c3ECF8E)";
const DOWN = "var(--cFF7A7A)";
const MUTED = "var(--c7C8894)";

export interface LeagueViewRow {
  key: string; rank: string; model: string; kind: string; ideas: string; hit: string; hitColor: string; avg: string; avgColor: string; seats: string; small: boolean;
}

/** Display rows. Fewer than 20 scored ideas is flagged as a small sample: a league isn't a verdict on 3 trades. */
export function leagueView(l: League | null): { rows: LeagueViewRow[]; note: string } | null {
  if (!l) return null;
  const rows = l.rows.map((r, i) => ({
    key: r.model, rank: String(i + 1), model: r.model.replace(/^(ollama|openrouter-free|openrouter):/, ""),
    kind: r.model.startsWith("ollama:") ? "OLLAMA" : r.model.startsWith("openrouter-free:") ? "OPENROUTER FREE" : r.model.startsWith("openrouter:") ? "OPENROUTER" : "BASELINE",
    ideas: r.ideas.toLocaleString("en-US"),
    hit: Math.round(r.hitRate * 100) + "%", hitColor: r.ideas < 20 ? MUTED : r.hitRate >= 0.5 ? UP : DOWN,
    avg: (r.avgReturnPct >= 0 ? "+" : "") + r.avgReturnPct.toFixed(3) + "%", avgColor: r.ideas < 20 ? MUTED : r.avgReturnPct >= 0 ? UP : DOWN,
    seats: r.seats.join(", "), small: r.ideas < 20,
  }));
  const note = l.scored === 0
    ? "No scored ideas yet. Each idea is scored a fixed time after it's made; give the floor a little while."
    : `${l.scored.toLocaleString("en-US")} scored ideas${l.source === "log+session" ? " across every session in the idea log" : " this session (the idea log is off)"}. Ranked by average move in the idea's direction. Grey rows have under 20 ideas: too few to judge.`;
  return { rows, note };
}

/** Polls the league while it's on screen (every 30 s). */
export function useLeague(active: boolean): League | null {
  const [l, setL] = useState<League | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => void fetchLeague().then((x) => live && x && setL(x));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active]);
  return l;
}
