import { z } from 'zod';
import { defaultAgents } from 'shared';
import type { AgentConfig, FloorMsg } from 'shared';
import { applyFill, mark, newBook, type Book } from './book';
import type { Advisor, ModelUsage } from './models';
import { DEFAULT_CRYPTO, type Instrument } from './instruments';
import type { Venue, VenueResult } from './venues';
import type { Headline } from './news';
import { createScorebook, type IdeaRecord, type ScoreDump, type Scorecard } from './scorecard';

/** What survives a restart: seat settings, every paper book (guests included) and the scorebook. Keyed by role. */
export interface FloorSnapshot {
  v: 1;
  savedAt: number;
  seats: Array<{ role: string; model: string; temperature: number; autonomy: AgentConfig['autonomy']; mandate: string; paused: boolean }>;
  guests: string[];
  books: Array<{ role: string; realized: number; positions: Array<{ symbol: string; qty: number; avg: number }>; day?: string; dayStartPnl?: number }>;
  /** Agent ids in `scores` are mapped back to roles through this. */
  ids: Record<string, string>;
  scores: ScoreDump;
}
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
  /** UTC day (YYYY-MM-DD) the loss stop is counting, and the seat's total P&L when that day began. */
  day?: string;
  dayStartPnl?: number;
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
  /** Stocks: false outside the US regular session. Agents don't decide and orders are refused while it's false. */
  marketOpen?: boolean;
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
    symbol: z.string().min(1).max(16), // checked against the instrument list by the engine
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
  /** The owner speaks to the floor: starts a conversation round about it. */
  z.object({ type: z.literal('instruct'), text: z.string().min(1).max(400) }),
  z.object({ type: z.literal('halt_all') }),
  z.object({ type: z.literal('resume_all') }),
]);

/** The default list (crypto only). A running engine's list is `engine.instruments`, which may include stocks. */
export const TRADED_SYMBOLS = DEFAULT_CRYPTO.map((i) => i.symbol);

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
  /** What the floor trades. Defaults to the built-in crypto list. */
  instruments?: Instrument[];
  /** The broker paper account for a symbol, if one is set up. Only orders the owner approves go there; everything else stays on core's paper venue. */
  route?: (symbol: string) => Venue | undefined;
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
  const instruments: Instrument[] = (opts.instruments ?? DEFAULT_CRYPTO).map((i) => ({ ...i }));
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
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
    c.subscriptions.size === 0 || msg.type === 'news' || msg.agentId === '*' || c.subscriptions.has(msg.agentId);

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
  /** Set by the floor conversation (talk.ts). Without it, owner instructions are ignored. */
  let onInstruct: ((text: string) => void) | undefined;
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
  /** `needsApproval`: true unless core is about to fill it itself (a stub seat on AUTO). Model seats always need approval. */
  const emitIntent = (agent: FloorAgent, symbol: string, tick: Tick, side: 'BUY' | 'SELL' | 'HOLD', size: number, confidence: number, rationale: string, needsApproval = true, fallback = false): string | null => {
    let ideaId: string | null = null;
    if (side === 'HOLD') scores.hold(ident(agent));
    else {
      ideaId = scores.idea({
        ...ident(agent), temperature: agent.config.temperature, autonomy: agent.config.autonomy, symbol, side, size, confidence, rationale,
        price: tick.price, change24h: tick.change24h, source: tick.source, ...(fallback ? { fallback: true } : {}),
      });
    }
    broadcast({ type: 'intent', agentId: agent.id, role: agent.config.role, symbol, side, size, confidence, rationale, needsApproval: side !== 'HOLD' && needsApproval, ts: now() });
    return ideaId;
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
          recordUsage(agent, 'usage' in res ? res.usage : undefined, res.ok ? undefined : res.reason);
          if (agent.state !== 'running' || agent.config.model !== modelId) return; // halted, paused or re-pointed while waiting
          const clip = agent.config.riskLimits.maxClip;
          if (res.ok) {
            const it = sizeIntent(res.view.side, res.view.confidence, clip, tick.price);
            emitIntent(agent, symbol, tick, it.side, it.size, it.confidence, `${modelId}: ${res.view.rationale}`);
          } else {
            log.warn(`model ${modelId} unavailable for ${agent.config.role}: ${res.reason}`);
            const m = momentumIntent(tick.change24h, clip, tick.price);
            emitIntent(agent, symbol, tick, m.side, m.size, m.confidence, `${modelId} unavailable (${res.reason}); stub momentum rule instead`, true, true);
          }
        });
      return;
    }

    const { side, size, confidence } = momentumIntent(tick.change24h, agent.config.riskLimits.maxClip, tick.price);
    const change = tick.change24h ?? 0;
    emitIntent(agent, symbol, tick, side, size, confidence, `${agent.config.role} read ${tick.source}: ${change.toFixed(2)}% over 24h (stub momentum rule)`, agent.config.autonomy !== 'AUTO');

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
  /** Every limit check an order passes before it is booked or sent to a broker. Returns the veto, or the price to book at. */
  const checkOrder = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', size: number): { ok: false; result: OrderResult } | { ok: true; price: number } => {
    const price = lastPx.get(symbol);
    const veto = (why: string): { ok: false; result: OrderResult } => {
      scores.veto(ident(agent));
      broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: 'HOLD', size: 0, price: price ?? 1, rationale: why, riskChecked: false, ts: now() });
      return { ok: false, result: { ok: false, reason: why } };
    };
    if (agent.state !== 'running') return veto('Floor is halted: order not placed');
    if (!bySymbol.has(symbol)) return veto(`${symbol} is not traded on this floor: order not placed`);
    if (price === undefined) return veto('No price for this symbol yet: order not placed');
    if (lastTick.get(symbol)?.marketOpen === false) return veto('The US market is closed: order not placed');
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
    return { ok: true, price };
  };

  const bookOrder = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', size: number, price: number, rationale: string, venue?: { id: Venue['id']; orderId: string }): OrderResult => {
    fillBook(agent, symbol, side, size, price);
    broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: side, size, price, rationale, riskChecked: true, ...(venue ? { venue: venue.id, venueOrderId: venue.orderId } : {}), ts: now() });
    const p = pnlMsg(agent);
    broadcast(p);
    return { ok: true, symbol, side, size, price, pnl: p.type === 'pnl' ? p.pnl : 0, exposure: p.type === 'pnl' ? p.exposure : 0 };
  };

  /** The paper venue: fill at core's last price. */
  const submitOrder = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', size: number, note: string): OrderResult => {
    const c = checkOrder(agent, symbol, side, size);
    return c.ok ? bookOrder(agent, symbol, side, size, c.price, `${note} · within risk limits`) : c.result;
  };

  /**
   * A broker paper account (Alpaca paper, Binance testnet): the same checks, then the order goes to the broker and the
   * paper book takes the broker's fill (its quantity and price), whatever happens on the floor meanwhile: the order is out.
   */
  const routeOrder = async (agent: FloorAgent, venue: Venue, symbol: string, side: 'BUY' | 'SELL', size: number, note: string): Promise<OrderResult> => {
    const c = checkOrder(agent, symbol, side, size);
    if (!c.ok) return c.result;
    const reject = (why: string): OrderResult => {
      broadcast({ type: 'decision', agentId: agent.id, role: agent.config.role, symbol, action: 'HOLD', size: 0, price: lastPx.get(symbol) ?? c.price, rationale: why, riskChecked: false, venue: venue.id, ts: now() });
      return { ok: false, reason: why };
    };
    const res = await venue.submit({ symbol, side, qty: size }).catch((e: unknown): VenueResult => ({ ok: false, reason: e instanceof Error ? e.message.slice(0, 160) : 'failed' }));
    if (!res.ok) {
      log.warn(`${venue.label} refused ${side} ${size} ${symbol}: ${res.reason}`);
      return reject(`${venue.label} refused the order: ${res.reason}`);
    }
    const { qty, price, orderId } = res.fill;
    // The broker's numbers are untrusted: never book more than was asked for, or a price that isn't a price.
    if (!(qty > 0) || qty > size * 1.0001 || !(price > 0) || !Number.isFinite(price)) return reject(`${venue.label} sent a fill core can't book (order ${orderId}); check the broker account`);
    const mkt = lastPx.get(symbol) ?? c.price;
    const gap = Math.abs(price / mkt - 1) * 100;
    const extra = [res.note, gap >= 1 ? `fill ${gap.toFixed(1)}% from the market price` : ''].filter(Boolean).join(', ');
    return bookOrder(agent, symbol, side, qty, price, `${note} · filled on ${venue.label}, order ${orderId}${extra ? ` (${extra})` : ''} · within risk limits`, { id: venue.id, orderId });
  };

  const placeOrder = (role: string, symbol: string, side: 'BUY' | 'SELL', size: number): void => {
    if (!bySymbol.has(symbol)) return; // like a malformed message: not something this floor trades
    const agent = agents.find((a) => norm(a.config.role) === norm(role) && a.config.trades && !a.external);
    if (!agent) return;
    const venue = opts.route?.(symbol);
    if (venue?.ready()) void routeOrder(agent, venue, symbol, side, size, 'Approved by operator');
    else submitOrder(agent, symbol, side, size, 'Approved by operator');
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

  // ---- model usage per seat, today (UTC) --------------------------------------------------------------------------
  interface Usage { day: string; calls: number; tokens: number; spend: number; spendKnown: boolean; latencyMs: number | null; error: string | null }
  const usageBy = new Map<string, Usage>();
  const usageSent = new Map<string, number>();
  const usageMsg = (a: FloorAgent): FloorMsg => {
    const u = usageBy.get(a.id);
    const today = new Date(now()).toISOString().slice(0, 10);
    const cur = u && u.day === today ? u : null;
    return {
      type: 'usage', agentId: a.id, role: a.config.role, callsToday: cur?.calls ?? 0, tokensToday: cur?.tokens ?? 0,
      spendToday: cur ? (cur.spendKnown ? Number(cur.spend.toFixed(6)) : null) : 0, latencyMs: u?.latencyMs ?? null, lastError: u?.error ?? null, ts: now(),
    };
  };
  /**
   * Count one model call against a seat and tell clients (at most once a second per seat). A failed call passes its
   * reason instead, so the Desk can say why a seat isn't talking (no key, model gone, rate limit) rather than go quiet.
   */
  const recordUsage = (a: FloorAgent, u: ModelUsage | undefined, error?: string): void => {
    if (!u && !error) return;
    const today = new Date(now()).toISOString().slice(0, 10);
    let cur = usageBy.get(a.id);
    if (!cur || cur.day !== today) cur = { day: today, calls: 0, tokens: 0, spend: 0, spendKnown: true, latencyMs: null, error: null };
    const before = cur.error;
    cur.error = error ? clean(error, 200) : null;
    if (!u) {
      usageBy.set(a.id, cur);
      if (cur.error !== before) broadcast(usageMsg(a));
      return;
    }
    cur.calls += 1;
    cur.tokens += Math.round(u.promptTokens + u.completionTokens);
    if (u.costUsd === null) cur.spendKnown = false;
    else cur.spend += u.costUsd;
    cur.latencyMs = Math.round(u.latencyMs);
    usageBy.set(a.id, cur);
    const t = now();
    if (t - (usageSent.get(a.id) ?? 0) >= 1000 || before !== null) {
      usageSent.set(a.id, t);
      broadcast(usageMsg(a));
    }
  };

  /** Clean text for the floor: no control characters, collapsed whitespace, capped. */
  // eslint-disable-next-line no-control-regex
  const clean = (raw: string, max: number) => raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  /** A seat (or the owner) says something in the floor conversation. No rate limit: core decides who speaks when. */
  const speak = (who: { id: string; role: string; name: string }, raw: string, meta: { round?: string; model?: string; stub?: boolean } = {}): string | null => {
    const text = clean(raw, 480);
    if (!text) return null;
    broadcast({ type: 'chat', agentId: who.id, role: who.role, name: who.name, text, ts: now(), ...meta });
    return text;
  };

  /** Tell the Desk a seat is working on its line (so a slow model shows as thinking, not as silence). */
  const thinking = (a: FloorAgent, round: string, on: boolean): void => {
    broadcast({ type: 'thinking', agentId: a.id, role: a.config.role, round: round.slice(0, 32), on, ts: now() });
  };

  /**
   * An idea raised in conversation becomes an intent like any other: sized by core, counted on the scorecard, and
   * (for SUGGEST/APPROVE seats, and every model seat) waiting for a human. Refused for seats that don't trade.
   */
  const proposeIdea = (agent: FloorAgent, symbol: string, side: 'BUY' | 'SELL', confidence: number, rationale: string): { ok: true; size: number; ideaId: string | null } | { ok: false; reason: string } => {
    if (!agent.config.trades || agent.external) return { ok: false, reason: 'this seat does not trade' };
    if (agent.state !== 'running') return { ok: false, reason: 'seat is not running' };
    if (!bySymbol.has(symbol)) return { ok: false, reason: 'not an instrument on this floor' };
    const tick = lastTick.get(symbol);
    if (!tick) return { ok: false, reason: 'no price yet' };
    if (tick.marketOpen === false) return { ok: false, reason: 'market closed' };
    const it = sizeIntent(side, confidence, agent.config.riskLimits.maxClip, tick.price);
    if (it.side === 'HOLD') return { ok: false, reason: 'too small to size' };
    const ideaId = emitIntent(agent, symbol, tick, it.side, it.size, it.confidence, clean(rationale, 240));
    return { ok: true, size: it.size, ideaId };
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
    // The loss stop counts today's P&L (UTC): a new day starts from wherever the book stands.
    const today = new Date(now()).toISOString().slice(0, 10);
    if (a.day !== today) {
      a.day = today;
      a.dayStartPnl = v.pnl;
    }
    a.dailyPnL = v.pnl - (a.dayStartPnl ?? 0);
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

  /** The latest headlines, newest first, so a new client sees the panel filled. */
  const newsSent: FloorMsg[] = [];
  const postNews = (items: Headline[]): void => {
    for (const h of items) {
      const msg: FloorMsg = { type: 'news', ...h, symbols: h.symbols.slice(0, 12), ts: now() };
      newsSent.unshift(msg);
      broadcast(msg);
    }
    newsSent.splice(20);
  };

  return {
    agents,
    postNews,
    thinking,

    /** Called by the feed on every price tick. Only the symbol that moved is evaluated. */
    pushTick(symbol: string, tick: Tick): void {
      if (!bySymbol.has(symbol)) return;
      lastPx.set(symbol, tick.price);
      lastTick.set(symbol, { ...tick, ts: now() });
      scores.tick(symbol, tick.price);
      // A closed market still marks the books, but nobody decides on a price that isn't moving.
      if (tick.marketOpen !== false) for (const a of agents) evaluate(a, symbol, tick);
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

    /** Everything worth keeping across a restart. */
    snapshot(): FloorSnapshot {
      return {
        v: 1,
        savedAt: now(),
        seats: agents.filter((a) => !a.external).map((a) => ({
          role: a.config.role, model: a.config.model, temperature: a.config.temperature, autonomy: a.config.autonomy, mandate: a.config.mandate, paused: pausedSeats.has(a.id),
        })),
        guests: agents.filter((a) => a.external).map((a) => a.config.name),
        books: agents.filter(hasBook).map((a) => ({
          role: a.config.role, realized: a.book.realized, day: a.day, dayStartPnl: a.dayStartPnl,
          positions: [...a.book.positions.entries()].map(([symbol, p]) => ({ symbol, qty: p.qty, avg: p.avg })),
        })),
        ids: Object.fromEntries(agents.map((a) => [a.id, a.config.role])),
        scores: scores.dump(),
      };
    },

    /**
     * Put a snapshot back. Seats are matched by role, so a renamed or removed seat is skipped rather than guessed at.
     * Call before any client connects or any tick arrives.
     */
    restore(snap: FloorSnapshot): void {
      for (const name of snap.guests) registerGuest(name);
      const byRole = (role: string) => agents.find((a) => norm(a.config.role) === norm(role));
      for (const s of snap.seats) {
        const a = byRole(s.role);
        if (!a || a.external) continue;
        a.config.model = s.model;
        a.config.temperature = s.temperature;
        a.config.autonomy = s.autonomy;
        a.config.mandate = s.mandate;
        if (s.paused) pausedSeats.add(a.id);
        else pausedSeats.delete(a.id);
        a.state = stateOf(a);
      }
      for (const b of snap.books) {
        const a = byRole(b.role);
        if (!a) continue;
        a.book = newBook();
        a.book.realized = b.realized;
        for (const p of b.positions) if (p.qty !== 0 && p.avg > 0) a.book.positions.set(p.symbol, { qty: p.qty, avg: p.avg });
        // Same UTC day: the loss stop keeps counting from where it was. Otherwise the next mark starts a new day.
        a.day = b.day;
        a.dayStartPnl = b.dayStartPnl;
        a.dailyPnL = b.realized - (b.dayStartPnl ?? b.realized); // until the first tick marks the open positions
      }
      scores.load(snap.scores, (oldId) => {
        const role = snap.ids[oldId];
        return role ? byRole(role)?.id : undefined;
      });
      for (const a of agents) scoreSent.set(a.id, { at: Number.NEGATIVE_INFINITY, stamp: -1 }); // send fresh cards on the next tick
      log.info(`restored ${snap.books.length} paper book(s), ${snap.scores.ideas.length} idea(s) and ${snap.guests.length} guest seat(s) from ${new Date(snap.savedAt).toISOString()}`);
    },

    /** Start every paper book and scorecard again from zero. Seat settings are kept. */
    resetPaper(): void {
      for (const a of agents) {
        a.book = newBook();
        a.dailyPnL = 0;
        a.day = undefined;
        a.dayStartPnl = undefined;
      }
      scores.reset();
      for (const a of agents) broadcast(pnlMsg(a));
      for (const c of scores.cards()) {
        scoreSent.set(c.agentId, { at: now(), stamp: scores.rev(c.agentId) });
        broadcast(scorecardMsg(c));
      }
      log.info('paper books and scorecards reset');
    },

    /** Every seat's track record, and every idea this session with its outcome once known. */
    scorecards: (): Scorecard[] => scores.cards(),
    ideas: (): IdeaRecord[] => scores.ideas(),
    scorecardOf: (id: string): Scorecard | undefined => scores.cardOf(id),
    scoreHorizonMs: scores.horizonMs,

    haltAll,
    resumeAll,

    // ---- floor conversation (talk.ts) ----
    setInstructHandler(fn: ((text: string) => void) | undefined): void {
      onInstruct = fn;
    },
    speak,
    proposeIdea,
    recordUsage,
    /** Latest tick per symbol, for the conversation's market picture. */
    ticks: () => new Map(lastTick),
    advisor,

    // ---- for guest agents (MCP) ----
    registerGuest,
    submitOrder,
    routeOrder,
    post,
    quotes: () =>
      [...lastTick.entries()].map(([symbol, t]) => ({
        symbol, kind: bySymbol.get(symbol)?.kind ?? 'crypto', price: t.price, change24h: t.change24h, source: t.source, ts: t.ts,
        ...(t.marketOpen === undefined ? {} : { marketOpen: t.marketOpen }),
      })),
    /** What this floor trades. */
    instruments: (): Instrument[] => instruments.map((i) => ({ ...i })),
    symbols: (): string[] => instruments.map((i) => i.symbol),
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
        todayPnl: a.dailyPnL,
        lossStopRemaining: Math.max(0, l.dailyLossStop + a.dailyPnL),
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
      for (const a of agents) if (usageBy.has(a.id)) ws.send(JSON.stringify(usageMsg(a)));
      for (const n of [...newsSent].reverse()) ws.send(JSON.stringify(n));
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
        } else if (msg.type === 'instruct') {
          onInstruct?.(msg.text);
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
