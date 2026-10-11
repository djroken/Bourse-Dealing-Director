import { z } from 'zod';
import { defaultAgents } from 'shared';
import type { AgentConfig, FloorMsg } from 'shared';
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
  /** Signed: losses are negative. Nothing writes this yet; the execution layer will. */
  dailyPnL: number;
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
export function momentumIntent(change24h: number | null, maxClip: number): { side: 'BUY' | 'SELL' | 'HOLD'; size: number; confidence: number } {
  const change = change24h ?? 0;
  const confidence = Math.min(Math.abs(change) / 5, 0.95);
  const size = clampClip(Math.floor((maxClip * confidence) / 2), maxClip);
  const side = change < 0 ? 'SELL' : change > 0 ? 'BUY' : 'HOLD';
  return size === 0 ? { side: 'HOLD', size: 0, confidence: Number(confidence.toFixed(2)) } : { side, size, confidence: Number(confidence.toFixed(2)) };
}

export function createEngine(opts: EngineOptions = {}) {
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? 15_000;
  const log: Logger = opts.log ?? { info: () => {}, warn: () => {} };

  const agents: FloorAgent[] = defaultAgents.map((config, i) => ({
    id: `TKT-${String(i + 1).padStart(3, '0')}`,
    config,
    state: 'running',
    dailyPnL: 0,
  }));

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

    const { side, size, confidence } = momentumIntent(tick.change24h, agent.config.riskLimits.maxClip);
    const change = tick.change24h ?? 0;
    broadcast({
      type: 'intent', agentId: agent.id, role: agent.config.role, symbol, side, size, confidence,
      rationale: `${agent.config.role} read ${tick.source}: ${change.toFixed(2)}% over 24h (stub momentum rule)`,
      ts: now(),
    });

    // SUGGEST and APPROVE agents stop at the intent: a human (or the approvals queue) decides.
    if (agent.config.autonomy !== 'AUTO' || side === 'HOLD') return;
    const ok = withinLossStop(agent.dailyPnL, agent.config.riskLimits.dailyLossStop);
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

  const setAll = (state: 'running' | 'halted'): number => {
    for (const a of agents) {
      a.state = state;
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
      for (const a of agents) evaluate(a, symbol, tick);
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
