import { z } from 'zod';
import { defaultAgents } from 'shared';
import type { AgentConfig, FloorMsg } from 'shared';
import { applyFill, mark, newBook, type Book } from './book';
import type { Advisor } from './models';
import { createScorebook, type IdeaRecord, type Scorecard } from './scorecard';
import { clampClip, withinLossStop } from './risk';

/** The slice of a WebSocket the engine needs, so tests can use a plain fake. */
export interface FloorSocket {
  readyState: number;
  send(data: string): void;
  on(event: 'message', cb: (data: unknown) => void): unknown;
  on(event: 'close' | 'error', cb: () => void): unknown;
}
const WS_OPEN = 1;

export type AgentState = 'initialized' | 'running' | 'paused' | 'halted';
export interface FloorAgent {
  id: string;
  config: AgentConfig;
  state: AgentState;
  /** Signed: losses are negative. Realised + unrealised on the paper book; this is what the loss stop reads. */
  dailyPnL: number;
  book: Book;
  /** A guest agent connected over MCP. It trades only when it calls place_order; core's stub/model rules skip it. */
  external?: boolean;
}

/** Risk limits every guest agent gets. USD; sized for the $100k paper book. Not editable by the guest. */
export const GUEST_LIMITS = { maxClip: 5000, maxLeverage: 3, dailyLossStop: 1000 };
export const PAPER_CAPITAL = 100_000;
const MAX_GUESTS = 8;

export type OrderResult =
  | { ok: true; symbol: string; side: 'BUY' | 'SELL'; size: number; price: number; pnl: number; exposure: number }
  | { ok: false; reason: string };
export interface Tick {
  price: number;
  change24h: number | null;
  source: string;
}
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Everything a client may send to /agents. Anything else is dropped. */
export const InboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), agentId: z.string().min(1).max(64), subscribe: z.boolean().default(true) }),
  /** An operator-approved order for a trading seat. Goes through the same risk checks as an agent's own decision. */
  z.object({
    type: z.literal('place_order'),
    role: z.string().min(1).max(64),
    symbol: z.enum(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']),
    side: z.enum(['BUY', 'SELL']),
    size: z.number().positive().finite(),
  }),
  /** Change a seat's settings. Risk limits are deliberately not editable over the wire. */
  z.object({
    type: z.literal('configure_agent'),
    role: z.string().min(1).max(64),
    autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']).optional(),
    paused: z.boolean().optional(),
    model: z.string().min(1).max(96).optional(),
    temperature: z.number().min(0).max(2).optional(),
    mandate: z.string().max(2000).optional(),
  }),
  z.object({ type: z.literal('halt_all') }),
  z.object({ type: z.literal('resume_all') }),
]);

export const TRADED_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

export interface EngineOptions {
  now?: () => number;
  /** Minimum gap between evaluations of the same agent on the same symbol. */
  cooldownMs?: number;
  /** Gap between model calls for the same seat and symbol. Longer than cooldownMs because models cost time (and maybe money). */
  modelCooldownMs?: number;
  /** Asks real models for a view. Without one, every seat runs the stub rule. */
  advisor?: Advisor;
  log?: Logger;
  /** How long after an idea its outcome is scored. Default 15 minutes. */
  scoreHorizonMs?: number;
  /** Called once per idea when its outcome is known (the server appends these to a training log). */
  onIdeaResolved?: (rec: IdeaRecord) => void;
}

/** Scorecards go out at most this often per seat, so a busy tick doesn't flood clients. */
const SCORECARD_EVERY_MS = 2_000;

/** Stub strategy: 24h momentum. Stands in for a model call; it is not trading advice and is not meant to make money. */
/** Core, not the model, decides the size: a fraction of the clip scaled by confidence, in asset units rounded down. */
export function sizeIntent(side: 'BUY' | 'SELL' | 'HOLD', confidence: number, maxClipUsd: number, price: number): { side: 'BUY' | 'SELL' | 'HOLD'; size: number; confidence: number } {
  const c = Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 0.95) : 0;
  const notional = clampClip((maxClipUsd * c) / 2, maxClipUsd);
  const size = Number.isFinite(price) && price > 0 ? Math.floor((notional / price) * 1e4) / 1e4 : 0;
  const conf = Number(c.toFixed(2));
  return size === 0 || side === 'HOLD' ? { side: 'HOLD', size: 0, confidence: conf } : { side, size, confidence: conf };
}

export function momentumIntent(change24h: number | null, maxClipUsd: number, price: number): { side: 'BUY' | 'SELL' | 'HOLD'; size: number; confidence: number } {
  const change = change24h ?? 0;
  const confidence = Math.min(Math.abs(change) / 5, 0.95);
  // maxClip is USD per order. Size is in asset units, rounded down so rounding can never push an order over the clip.
  const notional = clampClip((maxClipUsd * confidence) / 2, maxClipUsd);
  const size = Number.isFinite(price) && price > 0 ? Math.floor((notional / price) * 1e4) / 1e4 : 0;
  const side = change < 0 ? 'SELL' : change > 0 ? 'BUY' : 'HOLD';
  return size === 0 ? { side: 'HOLD', size: 0, confidence: Number(confidence.toFixed(2)) } : { side, size, confidence: Number(confidence.toFixed(2)) };
}

export function createEngine(opts: EngineOptions = {}) {
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? 15_000;
  const modelCooldownMs = opts.modelCooldownMs ?? 300_000;
  const advisor = opts.advisor;
  const inFlight = new Set<string>();
  const log: Logger = opts.log ?? { info: () => {}, warn: () => {} };

  const agents: FloorAgent[] = defaultAgents.map((config, i) => ({
    id: `TKT-${String(i + 1).padStart(3, '0')}`,
    config: structuredClone(config), // seats are edited at runtime: never mutate the shared seed
    state: 'running',
    dailyPnL: 0,
    book: newBook(),
  }));
  const scores = createScorebook({ now, horizonMs: opts.scoreHorizonMs, onResolved: opts.onIdeaResolved });
  const ident = (a: FloorAgent) => ({ agentId: a.id, role: a.config.role, name: a.config.name, model: a.config.model });
  /** What was last broadcast per seat. Seeded at creation: clients get every card on connect, so only changes go out after that. */
  const scoreSent = new Map<string, { at: number; stamp: number }>();
  const seedScore = (a: FloorAgent) => {
    scores.ensure(ident(a));
    scoreSent.set(a.id, { at: Number.NEGATIVE_INFINITY, stamp: scores.rev(a.id) });
  };
  for (const a of agents) seedScore(a);
  const lastPx = new Map<string, number>();
  const lastTick = new Map<string, Tick & { ts: number }>();
  const recent: FloorMsg[] = [];
  const postLog = new Map<string, number[]>();

  interface Client {
    ws: FloorSocket;
    /** Agent ids this client wants. Empty means everything. */
    subscriptions: Set<string>;
  }
  const clients = new Set<Client>();
  const lastEval = new Map<string, number>();

  const wants = (c: Client, msg: FloorMsg): boolean =>
    c.subscriptions.size === 0 || msg.agentId === '*' || c.subscriptions.has(msg.agentId);

  const broadcast = (msg: FloorMsg): void => {
    if (msg.type === 'intent' || msg.type === 'decision' || msg.type === 'chat') {
      recent.push(msg);
      if (recent.length > 60) recent.shift();
    }
    const payload = JSON.stringify(msg);
    for (const c of clients) {
      if (c.ws.readyState === WS_OPEN && wants(c, msg)) c.ws.send(payload);
    }
  };

  let floorHalted = false;
  /** Seats an operator paused one by one. Kept apart from HALT ALL so resuming the floor doesn't undo them. */
  const pausedSeats = new Set<string>();
  const stateOf = (a: FloorAgent): AgentState => (floorHalted ? 'halted' : pausedSeats.has(a.id) ? 'paused' : 'running');
  const norm = (r: string) => r.toUpperCase().replace(/\s+/g, ' ').trim(); // the Desk shows roles in capitals
  const configMsg = (a: FloorAgent): FloorMsg => ({
    type: 'config', agentId: a.id, role: a.config.role, name: a.config.name, model: a.config.model, temperature: a.config.temperature,
    autonomy: a.config.autonomy, mandate: a.config.mandate, paused: pausedSeats.has(a.id), riskLimits: { ...a.config.riskLimits }, ts: now(),
  });

  type Configure = { autonomy?: AgentConfig['autonomy']; paused?: boolean; model?: string; temperature?: number; mandate?: string };
  const configure = (role: string, patch: Configure): void => {
    const a = agents.find((x) => norm(x.config.role) === norm(role));
    if (!a) return;
    if (patch.autonomy !== undefined) a.config.autonomy = patch.autonomy;
    if (patch.model !== undefined) a.config.model = patch.model;
    if (patch.temperature !== undefined) a.config.temperature = patch.temperature;
    if (patch.mandate !== undefined) a.config.mandate = patch.mandate;
    if (patch.paused !== undefined) {
      if (patch.paused) pausedSeats.add(a.id);
      else pausedSeats.delete(a.id);
      // A halted floor stays halted: one seat can't be resumed past HALT ALL, it just won't be paused afterwards.
      const next = stateOf(a);
      if (a.state !== next) {
        a.state = next;
        broadcast(lifecycle(a));
      }
    }
    broadcast(configMsg(a));
  };

  const lifecycle = (a: FloorAgent): FloorMsg => ({
    type: 'lifecycle', agentId: a.id, role: a.config.role, status: a.state, ts: now(),
  });
  const floorLifecycle = (status: 'halted' | 'running'): FloorMsg => ({
    type: 'lifecycle', agentId: '*', role: 'floor', status, ts: now(),
  });

  /** Every intent goes through here so the scorebook sees it with the market context it was made in. */
  const emitIntent = (agent: FloorAgent, symbol: string, tick: Tick, side: 'BUY' | 'SELL' | 'HOLD', size: number, confidence: number, rationale: string): void => {
    if (side === 'HOLD') scores.hold(ident(agent));
    else {
      scores.idea({
        ...ident(agent), temperature: agent.config.temperature, autonomy: agent.config.autonomy, symbol, side, size, confidence, rationale,
        price: tick.price, change24h: tick.change24h, source: tick.source,
      });
    }
    broadcast({ type: 'intent', agentId: agent.id, role: agent.config.role, symbol, side, size, confidence, rationale, ts: now() });
  };

  /** Every paper fill goes through here so the scorebook can count closes and wins. */
  const fillBook = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', size: number, price: number): void => {
    const before = agent.book.realized;
    applyFill(agent.book, symbol, side, size, price);
    scores.fill(ident(agent), symbol, side, size, price, agent.book.realized - before);
  };

  const scorecardMsg = (c: Scorecard): FloorMsg => ({ type: 'scorecard', ...c, ts: now() });

  const evaluate = (agent: FloorAgent, symbol: string, tick: Tick): void => {
    if (agent.external || agent.state !== 'running' || !agent.config.trades) return;
    const key = `${agent.id}:${symbol}`;
    const last = lastEval.get(key);
    const isModelSeat = !!advisor?.handles(agent.config.model);
    if (last !== undefined && now() - last < (isModelSeat ? modelCooldownMs : cooldownMs)) return;
    if (isModelSeat && inFlight.has(key)) return;
    lastEval.set(key, now());

    if (isModelSeat) {
      // Model seats are suggest-only: whatever the model says, it ends at an intent a human can act on.
      inFlight.add(key);
      const modelId = agent.config.model;
      void advisor!
        .advise(modelId, { role: agent.config.role, mandate: agent.config.mandate, symbol, price: tick.price, change24h: tick.change24h }, agent.config.temperature)
        .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : 'failed' }))
        .then((res) => {
          inFlight.delete(key);
          if (agent.state !== 'running' || agent.config.model !== modelId) return; // halted, paused or re-pointed while waiting
          const clip = agent.config.riskLimits.maxClip;
          if (res.ok) {
            const it = sizeIntent(res.view.side, res.view.confidence, clip, tick.price);
            emitIntent(agent, symbol, tick, it.side, it.size, it.confidence, `${modelId}: ${res.view.rationale}`);
          } else {
            log.warn(`model ${modelId} unavailable for ${agent.config.role}: ${res.reason}`);
            const m = momentumIntent(tick.change24h, clip, tick.price);
            emitIntent(agent, symbol, tick, m.side, m.size, m.confidence, `${modelId} unavailable (${res.reason}); stub momentum rule instead`);
          }
        });
      return;
    }

    const { side, size, confidence } = momentumIntent(tick.change24h, agent.config.riskLimits.maxClip, tick.price);
    const change = tick.change24h ?? 0;
    emitIntent(agent, symbol, tick, side, size, confidence, `${agent.config.role} read ${tick.source}: ${change.toFixed(2)}% over 24h (stub momentum rule)`);

    // SUGGEST and APPROVE agents stop at the intent: a human (or the approvals queue) decides.
    if (agent.config.autonomy !== 'AUTO' || side === 'HOLD') return;
    const ok = withinLossStop(agent.dailyPnL, agent.config.riskLimits.dailyLossStop);
    if (ok) fillBook(agent, symbol, side, size, tick.price);
    else scores.veto(ident(agent));
    broadcast({
      type: 'decision', agentId: agent.id, role: agent.config.role, symbol,
      action: ok ? side : 'HOLD',
      size: ok ? size : 0,
      price: tick.price,
      rationale: ok ? 'Within risk limits' : 'Daily loss stop reached: vetoed',
      riskChecked: ok,
      ts: now(),
    });
  };

  /**
   * The one way an order reaches a paper book from outside the stub/model rules: an operator's approval or a guest agent's
   * place_order. Rejected (never clamped) if it breaks a limit, so the caller sees exactly what happened.
   */
  const submitOrder = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', size: number, note: string): OrderResult => {
    const price = lastPx.get(symbol);
    const veto = (why: string): OrderResult => {
      scores.veto(ident(agent));
      broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: 'HOLD', size: 0, price: price ?? 1, rationale: why, riskChecked: false, ts: now() });
      return { ok: false, reason: why };
    };
    if (agent.state !== 'running') return veto('Floor is halted: order not placed');
    if (price === undefined) return veto('No price for this symbol yet: order not placed');
    if (!(size > 0) || !Number.isFinite(size)) return veto('Size must be a positive number: order not placed');
    const { maxClip, maxLeverage, dailyLossStop } = agent.config.riskLimits;
    if (size * price > maxClip) return veto(`Order is over the $${maxClip} clip: not placed`);
    if (!withinLossStop(agent.dailyPnL, dailyLossStop)) return veto('Daily loss stop reached: not placed');
    if (agent.external) {
      // Guests have no stub strategy to keep them small, so cap total exposure at maxLeverage x the paper book. Reducing is always fine.
      const cap = PAPER_CAPITAL * maxLeverage;
      const cur = mark(agent.book, lastPx).exposure;
      const oldQty = agent.book.positions.get(symbol)?.qty ?? 0;
      const post = cur - Math.abs(oldQty) * price + Math.abs(oldQty + (side === 'BUY' ? size : -size)) * price;
      if (post > cur && post > cap) return veto(`Would take exposure over $${cap} (${maxLeverage}x the $${PAPER_CAPITAL} paper book): not placed`);
    }
    fillBook(agent, symbol, side, size, price);
    broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: side, size, price, rationale: `${note} · within risk limits`, riskChecked: true, ts: now() });
    const p = pnlMsg(agent);
    broadcast(p);
    return { ok: true, symbol, side, size, price, pnl: p.type === 'pnl' ? p.pnl : 0, exposure: p.type === 'pnl' ? p.exposure : 0 };
  };

  const placeOrder = (role: string, symbol: string, side: 'BUY' | 'SELL', size: number): void => {
    const agent = agents.find((a) => norm(a.config.role) === norm(role) && a.config.trades && !a.external);
    if (agent) submitOrder(agent, symbol, side, size, 'Approved by operator');
  };

  const cleanName = (n: string): string => n.replace(/[^\w .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  /** Find or create the paper seat for a guest agent. Undefined when the floor already has the maximum number of guests. */
  const registerGuest = (rawName: string): FloorAgent | undefined => {
    const name = cleanName(rawName) || 'Guest agent';
    const role = `Guest: ${name}`;
    const found = agents.find((a) => a.external && norm(a.config.role) === norm(role));
    if (found) return found;
    if (agents.filter((a) => a.external).length >= MAX_GUESTS) return undefined;
    const guest: FloorAgent = {
      id: `GST-${String(agents.filter((a) => a.external).length + 1).padStart(3, '0')}`,
      external: true,
      state: stateOf({ id: '' } as FloorAgent),
      dailyPnL: 0,
      book: newBook(),
      config: {
        name, role, model: 'external agent (MCP)', temperature: 0, autonomy: 'AUTO', trades: true,
        mandate: 'A guest agent connected over MCP, trading the $100k paper book on live prices. Core enforces the limits.',
        riskLimits: { ...GUEST_LIMITS }, tools: ['mcp'], feeds: ['live-prices'],
      },
    };
    agents.push(guest);
    seedScore(guest);
    broadcast(lifecycle(guest));
    broadcast(configMsg(guest));
    log.info(`guest agent joined: ${name}`);
    return guest;
  };

  const post = (agent: FloorAgent, raw: string): { ok: true } | { ok: false; reason: string } => {
    // eslint-disable-next-line no-control-regex
    const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return { ok: false, reason: 'empty message' };
    const t = now();
    const log10 = (postLog.get(agent.id) ?? []).filter((x) => t - x < 10_000);
    if (log10.length >= 5) return { ok: false, reason: 'slow down: 5 messages per 10 seconds' };
    log10.push(t);
    postLog.set(agent.id, log10);
    broadcast({ type: 'chat', agentId: agent.id, role: agent.config.role, name: agent.config.name, text, ts: t });
    return { ok: true };
  };

  /** Mark one seat's paper book and tell clients. Halted seats are still marked: halting stops decisions, not prices. */
  const pnlMsg = (a: FloorAgent): FloorMsg => {
    const v = mark(a.book, lastPx);
    a.dailyPnL = v.pnl;
    scores.mark(ident(a), v.pnl);
    return { type: 'pnl', agentId: a.id, role: a.config.role, pnl: v.pnl, exposure: v.exposure, positions: v.positions, ts: now() };
  };
  const hasBook = (a: FloorAgent) => a.book.positions.size > 0 || a.book.realized !== 0;

  const setAll = (state: 'running' | 'halted'): number => {
    floorHalted = state === 'halted';
    for (const a of agents) {
      a.state = stateOf(a);
      broadcast(lifecycle(a));
    }
    broadcast(floorLifecycle(state));
    return agents.length;
  };

  const haltAll = (): number => {
    const n = setAll('halted');
    log.info(`floor halted (${n} agents)`);
    return n;
  };
  const resumeAll = (): number => {
    const n = setAll('running');
    log.info(`floor resumed (${n} agents)`);
    return n;
  };

  return {
    agents,

    /** Called by the feed on every price tick. Only the symbol that moved is evaluated. */
    pushTick(symbol: string, tick: Tick): void {
      if (!TRADED_SYMBOLS.includes(symbol)) return;
      lastPx.set(symbol, tick.price);
      lastTick.set(symbol, { ...tick, ts: now() });
      scores.tick(symbol, tick.price);
      for (const a of agents) evaluate(a, symbol, tick);
      for (const a of agents) if (hasBook(a)) broadcast(pnlMsg(a));
      // Scorecards that changed since they were last sent, at most once per SCORECARD_EVERY_MS per seat.
      const t = now();
      for (const c of scores.cards()) {
        const sent = scoreSent.get(c.agentId);
        const rev = scores.rev(c.agentId);
        if (sent && (sent.stamp === rev || t - sent.at < SCORECARD_EVERY_MS)) continue;
        scoreSent.set(c.agentId, { at: t, stamp: rev });
        broadcast(scorecardMsg(c));
      }
    },

    /** Every seat's track record, and every idea this session with its outcome once known. */
    scorecards: (): Scorecard[] => scores.cards(),
    ideas: (): IdeaRecord[] => scores.ideas(),
    scorecardOf: (id: string): Scorecard | undefined => scores.cardOf(id),
    scoreHorizonMs: scores.horizonMs,

    haltAll,
    resumeAll,

    // ---- for guest agents (MCP) ----
    registerGuest,
    submitOrder,
    post,
    quotes: () => [...lastTick.entries()].map(([symbol, t]) => ({ symbol, price: t.price, change24h: t.change24h, source: t.source, ts: t.ts })),
    positionsOf(a: FloorAgent) {
      const v = mark(a.book, lastPx);
      return { pnl: v.pnl, exposure: v.exposure, positions: v.positions.map((p) => ({ ...p, markPx: lastPx.get(p.symbol) ?? p.avgPx })) };
    },
    riskOf(a: FloorAgent) {
      const v = mark(a.book, lastPx);
      const l = a.config.riskLimits;
      return {
        state: a.state,
        paperCapital: PAPER_CAPITAL,
        limits: { ...l },
        maxExposure: PAPER_CAPITAL * l.maxLeverage,
        exposure: v.exposure,
        pnl: v.pnl,
        lossStopRemaining: Math.max(0, l.dailyLossStop + v.pnl),
      };
    },
    recentFloor: (n: number): FloorMsg[] => recent.slice(-Math.max(1, Math.min(n, 60))),

    setDailyPnL(id: string, pnl: number): boolean {
      const a = agents.find((x) => x.id === id);
      if (!a) return false;
      a.dailyPnL = pnl;
      return true;
    },

    summary(a: FloorAgent) {
      return {
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        model: a.config.model,
        temperature: a.config.temperature,
        autonomy: a.config.autonomy,
        state: a.state,
        mandate: a.config.mandate,
        riskLimits: a.config.riskLimits,
        tools: a.config.tools,
        feeds: a.config.feeds,
        dailyPnL: a.dailyPnL,
      };
    },

    /** Attach a socket to the floor. The client first receives every agent's current state. */
    addClient(ws: FloorSocket): void {
      const client: Client = { ws, subscriptions: new Set() };
      clients.add(client);
      for (const a of agents) ws.send(JSON.stringify(lifecycle(a)));
      for (const a of agents) ws.send(JSON.stringify(configMsg(a)));
      for (const a of agents) if (hasBook(a)) ws.send(JSON.stringify(pnlMsg(a)));
      for (const c of scores.cards()) ws.send(JSON.stringify(scorecardMsg(c)));
      log.info(`floor client connected (${clients.size})`);

      ws.on('message', (raw) => {
        let json: unknown;
        try {
          json = JSON.parse(String(raw));
        } catch {
          log.warn('floor client sent invalid JSON');
          return;
        }
        const parsed = InboundSchema.safeParse(json);
        if (!parsed.success) {
          log.warn('floor client sent an unsupported message');
          return;
        }
        const msg = parsed.data;
        if (msg.type === 'subscribe') {
          if (msg.subscribe) client.subscriptions.add(msg.agentId);
          else client.subscriptions.delete(msg.agentId);
        } else if (msg.type === 'configure_agent') {
          const { type: _t, role, ...patch } = msg;
          configure(role, patch);
        } else if (msg.type === 'place_order') {
          placeOrder(msg.role, msg.symbol, msg.side, msg.size);
        } else if (msg.type === 'halt_all') {
          haltAll();
        } else {
          resumeAll();
        }
      });
      const drop = () => {
        clients.delete(client);
      };
      ws.on('close', drop);
      ws.on('error', drop);
    },

    clientCount: (): number => clients.size,
  };
}

export type Engine = ReturnType<typeof createEngine>;
