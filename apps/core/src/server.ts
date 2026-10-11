import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { CoreConfig } from './config';
import { createEngine, type Engine, type Logger } from './engine';
import { fetchJson, pollFeeds, type FeedDeps, type FeedMsg } from './feeds';
import { MAX_SECRET_LENGTH, SECRET_ID, openSecretStore, parseMasterKey, type SecretStore } from './secrets';

export interface ServerDeps {
  /** Replaceable so tests never touch the network. */
  feedDeps?: FeedDeps;
  engine?: Engine;
  /** Overrides the store built from config (tests). */
  secrets?: SecretStore;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildServer(config: CoreConfig, deps: ServerDeps = {}) {
  const server: FastifyInstance = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : true, bodyLimit: 16 * 1024 });
  // Tolerate an empty body on application/json requests (a DELETE sent with a JSON content type), reject anything malformed.
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
    }
  });
  const log: Logger = { info: (m) => server.log.info(m), warn: (m) => server.log.warn(m) };
  const engine = deps.engine ?? createEngine({ log });
  const feedDeps: FeedDeps = deps.feedDeps ?? { fetchJson: (url, init) => fetchJson(url, { init }), now: Date.now };

  const originAllowed = (origin: string | undefined): boolean =>
    origin === undefined || config.allowedOrigins.includes(origin.replace(/\/$/, ''));

  // ---- HTTP: CORS + a guard so a random web page can't drive state-changing endpoints ----------------------------
  server.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && originAllowed(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      return reply
        .header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type')
        .code(204)
        .send();
    }
    if (!SAFE_METHODS.has(req.method) && !originAllowed(origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
    return undefined;
  });

  let lastUpdate = 0;
  const lastBySymbol = new Map<string, FeedMsg>();

  server.get('/', async () => ({ status: 'ok', service: 'hermes-core' }));
  server.get('/feeds', async () => ({
    intervalMs: config.feedIntervalMs,
    symbols: [...lastBySymbol.keys()],
    sources: ['binance', 'coinbase', 'frankfurter', 'hyperliquid'],
    lastUpdate,
  }));
  server.get('/agents', async () => engine.agents.map((a) => engine.summary(a)));
  server.get<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const a = engine.agents.find((x) => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    return engine.summary(a);
  });
  server.post('/agents/halt-all', async () => ({ ok: true, halted: engine.haltAll() }));
  server.post('/agents/resume-all', async () => ({ ok: true, resumed: engine.resumeAll() }));

  // ---- secrets: write-only over HTTP. Values are never returned, only that they exist. -------------------------------
  const secrets = deps.secrets ?? (config.masterKey ? openSecretStore({ file: join(config.dataDir, 'secrets.json'), key: parseMasterKey(config.masterKey) }) : undefined);
  const disabled = { error: 'secret store disabled: start core with HERMES_MASTER_KEY set (pnpm --filter core keygen)' };
  server.get('/secrets', async () => ({ enabled: !!secrets, secrets: secrets?.list() ?? [] }));
  server.put<{ Params: { id: string }; Body: { value?: unknown } }>('/secrets/:id', async (req, reply) => {
    if (!secrets) return reply.code(503).send(disabled);
    const value = req.body?.value;
    if (!SECRET_ID.test(req.params.id)) return reply.code(400).send({ error: 'invalid secret id' });
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_LENGTH) return reply.code(400).send({ error: 'invalid secret value' });
    return { ok: true, ...secrets.set(req.params.id, value) };
  });
  server.delete<{ Params: { id: string } }>('/secrets/:id', async (req, reply) => {
    if (!secrets) return reply.code(503).send(disabled);
    return secrets.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // ---- WebSocket: /agents (floor events + control) and / (market feed) ------------------------------------------
  const agentsWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const feedWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const feedClients = new Set<WebSocket>();

  agentsWss.on('connection', (ws) => engine.addClient(ws));
  feedWss.on('connection', (ws) => {
    feedClients.add(ws);
    for (const m of lastBySymbol.values()) ws.send(JSON.stringify(m));
    const drop = () => feedClients.delete(ws);
    ws.on('close', drop);
    ws.on('error', drop);
  });

  // Dead-connection sweep: terminate anything that hasn't answered the last ping.
  const alive = new WeakSet<WebSocket>();
  const sweep = setInterval(() => {
    for (const wss of [agentsWss, feedWss]) {
      for (const ws of wss.clients) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
    }
  }, 30_000);
  sweep.unref();
  for (const wss of [agentsWss, feedWss]) {
    wss.on('connection', (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
    });
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!originAllowed(req.headers.origin)) return reject(403, 'Forbidden');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const wss = path === '/agents' ? agentsWss : path === '/' || path === '/feed' ? feedWss : null;
    if (!wss) return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.server.on('upgrade', onUpgrade);

  // ---- feed loop -------------------------------------------------------------------------------------------------
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let stopped = false;

  const publish = (msg: FeedMsg) => {
    lastBySymbol.set(msg.type === 'funding' ? `funding:${msg.symbol}` : msg.symbol, msg);
    const payload = JSON.stringify(msg);
    for (const ws of feedClients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    if (msg.type === 'price') engine.pushTick(msg.symbol, { price: msg.price, change24h: msg.change24h, source: msg.source });
  };

  /** One poll, never overlapping the previous one. Exposed so tests can drive it. */
  const pollOnce = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const msgs = await pollFeeds(feedDeps);
      for (const m of msgs) publish(m);
      if (msgs.length) lastUpdate = feedDeps.now();
    } catch (err) {
      server.log.error(`feed poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      polling = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void pollOnce().finally(schedule), config.feedIntervalMs);
  };

  return {
    server,
    engine,
    pollOnce,
    async start(): Promise<number> {
      await server.listen({ port: config.port, host: config.host });
      const addr = server.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      void pollOnce().finally(schedule);
      return port;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      for (const wss of [agentsWss, feedWss]) for (const ws of wss.clients) ws.terminate();
      agentsWss.close();
      feedWss.close();
      await server.close();
    },
  };
}
