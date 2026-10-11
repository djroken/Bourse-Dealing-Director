import { z } from 'zod';
import { defaultAgents } from 'shared';
import type { AgentConfig, FloorMsg } from 'shared';
import { applyFill, mark, newBook, type Book } from './book';
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
}
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
    model: z.string().min(1).max(64).optional(),
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
  log?: Logger;
}

/** Stub strategy: 24h momentum. Stands in for a model call; it is not trading advice and is not meant to make money. */
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
  const log: Logger = opts.log ?? { info: () => {}, warn: () => {} };

  const agents: FloorAgent[] = defaultAgents.map((config, i) => ({
    id: `TKT-${String(i + 1).padStart(3, '0')}`,
    config: structuredClone(config), // seats are edited at runtime: never mutate the shared seed
    state: 'running',
    dailyPnL: 0,
    book: newBook(),
  }));
  const lastPx = new Map<string, number>();

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

  const evaluate = (agent: FloorAgent, symbol: string, tick: Tick): void => {
    if (agent.state !== 'running' || !agent.config.trades) return;
    const key = `${agent.id}:${symbol}`;
    const last = lastEval.get(key);
    if (last !== undefined && now() - last < cooldownMs) return;
    lastEval.set(key, now());

    const { side, size, confidence } = momentumIntent(tick.change24h, agent.config.riskLimits.maxClip, tick.price);
    const change = tick.change24h ?? 0;
    broadcast({
      type: 'intent', agentId: agent.id, role: agent.config.role, symbol, side, size, confidence,
      rationale: `${agent.config.role} read ${tick.source}: ${change.toFixed(2)}% over 24h (stub momentum rule)`,
      ts: now(),
    });

    // SUGGEST and APPROVE agents stop at the intent: a human (or the approvals queue) decides.
    if (agent.config.autonomy !== 'AUTO' || side === 'HOLD') return;
    const ok = withinLossStop(agent.dailyPnL, agent.config.riskLimits.dailyLossStop);
    if (ok) applyFill(agent.book, symbol, side, size, tick.price);
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

  /** Human-approved order. Rejected (never clamped) if it breaks a limit, so the operator sees exactly what happened. */
  const placeOrder = (role: string, symbol: string, side: 'BUY' | 'SELL', size: number): void => {
    const agent = agents.find((a) => norm(a.config.role) === norm(role) && a.config.trades);
    if (!agent) return;
    const price = lastPx.get(symbol);
    const veto = (why: string) =>
      broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: 'HOLD', size: 0, price: price ?? 1, rationale: why, riskChecked: false, ts: now() });
    if (agent.state !== 'running') return veto('Floor is halted: order not placed');
    if (price === undefined) return veto('No price for this symbol yet: order not placed');
    const { maxClip, dailyLossStop } = agent.config.riskLimits;
    if (size * price > maxClip) return veto(`Order is over the $${maxClip} clip: not placed`);
    if (!withinLossStop(agent.dailyPnL, dailyLossStop)) return veto('Daily loss stop reached: not placed');
    applyFill(agent.book, symbol, side, size, price);
    broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: side, size, price, rationale: 'Approved by operator · within risk limits', riskChecked: true, ts: now() });
    broadcast(pnlMsg(agent));
  };

  /** Mark one seat's paper book and tell clients. Halted seats are still marked: halting stops decisions, not prices. */
  const pnlMsg = (a: FloorAgent): FloorMsg => {
    const v = mark(a.book, lastPx);
    a.dailyPnL = v.pnl;
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
      for (const a of agents) evaluate(a, symbol, tick);
      for (const a of agents) if (hasBook(a)) broadcast(pnlMsg(a));
    },

    haltAll,
    resumeAll,

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
