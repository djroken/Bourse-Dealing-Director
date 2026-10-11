import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { defaultAgents } from 'shared';
import type { AgentConfig, FloorMsg } from 'shared';

interface FloorClient {
  ws: WebSocket;
  subscriptions: Set<string>; // agentIds they care about, empty = all
}

/**
 * Agent Engine — loads the 8 seed agents from packages/shared and runs a
 * lightweight autonomous loop for each. Agents ingest the latest market feed
 * (price + funding ticks received from the core feed loop), evaluate against
 * their mandate + risk limits, and broadcast lifecycle / intent / decision
 * messages on the /agents WebSocket feed.
 *
 * Autonomy modes (from AgentConfigSchema):
 *   AUTO   — decisions are broadcast directly (execution layer consumes them)
 *   SUGGEST — only intents are broadcast; a human/RO approval gate is expected
 *   APPROVE — reserved for future risk-gated approvals
 */
export async function registerAgentEngine(server: FastifyInstance): Promise<void> {
  const agentIdPrefix = 'TKT-';

  // Assign stable sequential IDs: TKT-001 … TKT-008
  interface FloorAgent {
    id: string;
    config: AgentConfig;
    state: 'initialized' | 'running' | 'paused' | 'halted';
    dailyPnL: number;
  }

  const agents: FloorAgent[] = defaultAgents.map((cfg, i) => ({
    id: `${agentIdPrefix}${String(i + 1).padStart(3, '0')}`,
    config: cfg,
    state: 'initialized',
    dailyPnL: 0,
  }));

  const clients = new Set<FloorClient>();
  let lastFeed: Record<string, { price: number; change24h: number | null; source: string }> = {};

  const broadcast = (msg: FloorMsg, toId?: string) => {
    const payload = JSON.stringify(msg);
    for (const c of clients) {
      if (!c.ws || c.ws.readyState !== WebSocket.OPEN) continue;
      if (toId && !c.subscriptions.has(toId) && c.subscriptions.size > 0) continue;
      c.ws.send(payload);
    }
    server.log.info({ type: msg.type, agentId: (msg as any).agentId }, 'floor broadcast');
  };

  // ---- Agent lifecycle hooks -------------------------------------------------
  for (const a of agents) {
    a.state = 'initialized';
    broadcast({
      type: 'lifecycle',
      agentId: a.id,
      role: a.config.role,
      status: 'initialized',
      ts: Date.now(),
    });
  }

  // Start agents (Dealing Director starts the rest)
  agents[0].state = 'running';
  broadcast({
    type: 'lifecycle',
    agentId: agents[0].id,
    role: agents[0].config.role,
    status: 'running',
    ts: Date.now(),
  });
  for (let i = 1; i < agents.length; i++) {
    const a = agents[i];
    broadcast({
      type: 'lifecycle',
      agentId: a.id,
      role: a.config.role,
      status: 'running',
      ts: Date.now(),
    });
    a.state = 'running';
  }

  // ---- Simple autonomous decision logic --------------------------------------
  // Each agent's tick evaluates the latest price feed against its role/mandate.
  // This is a stub-intent engine — real model calls would be injected via MCP.
  const evaluateAgent = (agent: FloorAgent) => {
    if (agent.state !== 'running') return;

    const feed = lastFeed;
    const cryptoSymbols = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

    for (const symbol of cryptoSymbols) {
      const tick = feed[symbol];
      if (!tick) continue;

      const change = tick.change24h ?? 0;
      const confidence = Math.min(Math.abs(change) / 5, 0.95);

      // Mandate-based heuristic (replaced by model call in production):
      //   negative momentum → SELL signal
      //   positive momentum → BUY signal
      const side: 'BUY' | 'SELL' | 'HOLD' = change < 0 ? 'SELL' : change > 0 ? 'BUY' : 'HOLD';
      const size = Math.max(0, Math.floor((agent.config.riskLimits.maxClip * confidence) / 2));

      const intent = {
        type: 'intent' as const,
        agentId: agent.id,
        role: agent.config.role,
        symbol,
        side,
        size,
        confidence: Number(confidence.toFixed(2)),
        rationale: `${agent.config.role} evaluated ${tick.source} feed: ${change.toFixed(2)}% momentum over 24h`,
        ts: Date.now(),
      };

      broadcast(intent);

      // AUTO agents proceed to decision; SUGGEST agents stop at intent
      if (agent.config.autonomy === 'AUTO' && side !== 'HOLD' && size > 0) {
        // Risk Officer vetoes if daily loss exceeds limit
        const riskOk = agent.dailyPnL < agent.config.riskLimits.dailyLossStop;
        const decision = {
          type: 'decision' as const,
          agentId: agent.id,
          role: agent.config.role,
          symbol,
          action: side,
          size,
          price: tick.price,
          rationale: riskOk ? 'Within risk limits' : 'Risk limit exceeded — halted',
          riskChecked: riskOk,
          ts: Date.now(),
        };
        broadcast(decision);
      }
    }
  };

  // ---- /agents WebSocket connection handler ---------------------------------
  const handleAgentConnection = (ws: WebSocket) => {
    void ws;
    const client: FloorClient = { ws, subscriptions: new Set<string>() };
    clients.add(client);
    server.log.info('Agent feed client connected');

    ws.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe' && typeof msg.agentId === 'string') {
          if (msg.subscribe) client.subscriptions.add(msg.agentId);
          else client.subscriptions.delete(msg.agentId);
        }
        if (msg.type === 'halt_all') {
          for (const a of agents) {
            a.state = 'halted';
            broadcast({
              type: 'lifecycle',
              agentId: a.id,
              role: a.config.role,
              status: 'halted',
              ts: Date.now(),
            });
          }
        }
      } catch (e) {
        server.log.warn('Agent feed parse error: ' + (e as Error).message);
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      server.log.info('Agent feed client disconnected');
    });

    ws.on('error', (err: Error) => {
      clients.delete(client);
      server.log.error('Agent feed WS error: ' + err.message);
    });
  };

  // ---- Public API for core integration --------------------------------------
  // Core calls floorPushFeed on every price tick to trigger agent evaluation.
  server.decorate('floorPushFeed', (symbol: string, data: { price: number; change24h: number | null; source: string }) => {
    lastFeed[symbol] = data;
    // Run a tick on every feed update so agents react immediately
    for (const a of agents) evaluateAgent(a);
  });

  server.decorate('floorHandleAgentConnection', handleAgentConnection);
  server.decorate('floorAgents', agents);
  server.decorate('floorBroadcast', broadcast);

  server.log.info('Agent engine registered with ' + agents.length + ' agents');

  // REST endpoints for agent state (desk UI can poll)
  server.get('/agents', async () => {
    return agents.map((a) => ({
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
    }));
  });

  server.get('/agents/:id', async (req) => {
    const a = agents.find((x) => x.id === (req.params as any).id);
    if (!a) return { error: 'not found' };
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
  });

  // HALT ALL endpoint (desk UI button)
  server.post('/agents/halt-all', async () => {
    for (const a of agents) {
      a.state = 'halted';
      broadcast({
        type: 'lifecycle',
        agentId: a.id,
        role: a.config.role,
        status: 'halted',
        ts: Date.now(),
      });
    }
    broadcast({
      type: 'lifecycle',
      agentId: '*',
      role: 'floor',
      status: 'halted',
      ts: Date.now(),
    } as any);
    return { ok: true, halted: agents.length };
  });
}
