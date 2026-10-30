import Fastify, { type FastifyInstance } from 'fastify';
import { appendFile, mkdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { CoreConfig } from './config';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_AGENT_HEADER, createMcpServer, tokenOk } from './mcp';
import { createAdvisor } from './models';
import { createEngine, type Engine, type Logger } from './engine';
import type { IdeaRecord } from './scorecard';
import { loadSnapshot, saveSnapshot } from './persist';
import { createReplayRunner, type ReplayTf } from './replay';
import { z } from 'zod';
import { cryptoFeeds, fetchJson, pollFeeds, type FeedDeps, type FeedMsg } from './feeds';
import { buildInstruments } from './instruments';
import { fetchClock, fetchStockBars, fetchStockQuotes, type AlpacaKeys, type MarketClock } from './alpaca';
import { fetchHistory } from './replay';
import { createTalk } from './talk';
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
  const advisor = createAdvisor({
    ollamaHost: config.ollamaHost,
    dailyCap: config.modelDailyCap,
    // Read at call time: a key saved in Setup works without a restart. The env var is the fallback.
    openrouterKey: () => secrets?.get('model.openrouter.key') ?? (process.env.OPENROUTER_API_KEY?.trim() || undefined),
  });
  // Training/eval log: one JSON line per idea once its outcome is known. Writes are queued so lines never interleave.
  const ideaFile = join(config.dataDir, 'ideas.jsonl');
  let ideaWrites: Promise<void> = Promise.resolve();
  const logIdea = (rec: IdeaRecord): void => {
    if (config.ideaLog === false) return;
    ideaWrites = ideaWrites
      .then(() => mkdir(config.dataDir, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(ideaFile, JSON.stringify(rec) + '\n', { mode: 0o600 }))
      .catch((err: unknown) => server.log.warn(`could not write ${ideaFile}: ${err instanceof Error ? err.message : String(err)}`));
  };
  // ---- instruments: crypto always; US stocks when an Alpaca market-data key is configured ----------------------------
  const secrets = deps.secrets ?? (config.masterKey ? openSecretStore({ file: join(config.dataDir, 'secrets.json'), key: parseMasterKey(config.masterKey) }) : undefined);
  /** Read at call time, so a key saved in Setup is used by the next poll (adding stocks to the list still needs a restart). */
  const alpacaKeys = (): AlpacaKeys | undefined => {
    const key = secrets?.get('data.alpaca.key') ?? (process.env.ALPACA_API_KEY_ID?.trim() || undefined);
    const secret = secrets?.get('data.alpaca.secret') ?? (process.env.ALPACA_API_SECRET_KEY?.trim() || undefined);
    return key && secret ? { key, secret } : undefined;
  };
  const built = buildInstruments({ extraCrypto: config.extraCrypto, stocks: config.stocks, stocksEnabled: !!alpacaKeys() });
  for (const w of built.warnings) server.log.warn(w);
  const engine = deps.engine ?? createEngine({ log, advisor, scoreHorizonMs: (config.scoreHorizonMin ?? 15) * 60_000, onIdeaResolved: logIdea, instruments: built.instruments });
  const instruments = engine.instruments();
  const stockSymbols = instruments.filter((i) => i.kind === 'stock').map((i) => i.symbol);
  const crypto = cryptoFeeds(instruments);
  let clock: (MarketClock & { at: number }) | null = null;
  // ---- paper state across restarts --------------------------------------------------------------------------------
  const stateFile = join(config.dataDir, 'state.json');
  const persist = config.persist !== false;
  if (persist) {
    const loaded = loadSnapshot(stateFile);
    if (loaded.kind === 'ok') engine.restore(loaded.snap);
    else if (loaded.kind === 'bad') server.log.warn(`ignored ${stateFile} (${loaded.reason}); moved it to ${loaded.movedTo} and started a fresh paper floor`);
  }
  const saveState = (): void => {
    if (!persist) return;
    try {
      saveSnapshot(stateFile, engine.snapshot());
    } catch (err) {
      server.log.warn(`could not save ${stateFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const saver = setInterval(saveState, 30_000);
  saver.unref();

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

  server.get('/', async () => ({ status: 'ok', service: 'bourse-core' }));
  server.get('/feeds', async () => ({
    intervalMs: config.feedIntervalMs,
    symbols: [...lastBySymbol.keys()],
    sources: ['binance', 'coinbase', 'frankfurter', 'hyperliquid', ...(stockSymbols.length ? ['alpaca'] : [])],
    lastUpdate,
  }));
  /** What the floor trades, and whether US stocks are on (and if the market is open). The Desk builds its tape from this. */
  server.get('/instruments', async () => ({
    instruments,
    stocks: {
      enabled: stockSymbols.length > 0,
      keySet: !!alpacaKeys(),
      // A key saved after start is used for quotes straight away, but adding stocks to the list needs a restart.
      needsRestart: stockSymbols.length === 0 && !!alpacaKeys(),
      market: clock ? { open: clock.open, nextOpen: clock.nextOpen, nextClose: clock.nextClose, from: clock.from } : null,
    },
  }));
  /** Candles for one stock, for the Desk's native chart (crypto candles come straight from the exchanges). */
  server.get<{ Querystring: { symbol?: string; tf?: string } }>('/candles', async (req, reply) => {
    const inst = instruments.find((i) => i.symbol === req.query.symbol);
    const tf = req.query.tf ?? '5m';
    const STEP: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
    if (!inst || inst.kind !== 'stock') return reply.code(400).send({ error: 'only stocks on this floor are served here' });
    if (!STEP[tf]) return reply.code(400).send({ error: 'tf must be one of 1m, 5m, 15m, 1h, 4h, 1d' });
    const keys = alpacaKeys();
    if (!keys) return reply.code(503).send({ error: 'no Alpaca key' });
    const to = feedDeps.now();
    // Markets are shut most of the week: ask for a window wide enough to hold 120 trading-hours candles.
    const from = to - Math.max(7 * 86_400_000, STEP[tf]! * 120 * 5);
    try {
      const bars = await fetchStockBars(feedDeps.fetchJson, keys, inst.symbol, tf, from, to, { max: 20_000 });
      return { symbol: inst.symbol, tf, candles: bars.slice(-120) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message.slice(0, 160) : 'failed' });
    }
  });
  server.get('/agents', async () => engine.agents.map((a) => engine.summary(a)));
  server.get<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const a = engine.agents.find((x) => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    return engine.summary(a);
  });
  server.post('/agents/halt-all', async () => ({ ok: true, halted: engine.haltAll() }));
  server.post('/agents/resume-all', async () => ({ ok: true, resumed: engine.resumeAll() }));

  // ---- secrets: write-only over HTTP. Values are never returned, only that they exist. -------------------------------
  const disabled = { error: 'secret store disabled: start core with BOURSE_MASTER_KEY set (pnpm --filter core keygen)' };
  // ---- MCP: guest agents trade their own paper book. Off unless BOURSE_MCP_TOKEN is set. Stateless: one server per request.
  const mcpHandler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!config.mcpToken || config.mcpToken.length < 16) {
      return reply.code(503).send({ error: 'MCP is off: start core with BOURSE_MCP_TOKEN set to a random string of 16+ characters' });
    }
    if (req.headers.origin !== undefined) return reply.code(403).send({ error: 'MCP is for agents, not browsers' }); // blocks DNS-rebinding style pages
    if (!tokenOk(config.mcpToken, req.headers.authorization)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'missing or wrong bearer token' });
    if (req.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({ error: 'POST only (stateless MCP)' });
    const name = String(req.headers[MCP_AGENT_HEADER] ?? req.headers['x-hermes-agent'] ?? '').slice(0, 64); // x-hermes-agent: old name, still accepted
    const guest = engine.registerGuest(name);
    if (!guest) return reply.code(429).send({ error: 'the floor already has the maximum number of guest agents' });
    const mcp = createMcpServer(engine, guest);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      server.log.error(`mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
    }
  };
  server.all('/mcp', mcpHandler);

  server.get('/models', async () => advisor.status());

  // ---- scorecards and the idea log ---------------------------------------------------------------------------------
  // ---- floor conversation ------------------------------------------------------------------------------------------
  const talk = createTalk({
    engine,
    log,
    intervalMs: (config.talkMin ?? 15) * 60_000,
    // Funding as % per 8h, from whatever the feed last published (Binance is per 8h, Hyperliquid per hour).
    funding: () => {
      const m = new Map<string, number>();
      for (const msg of lastBySymbol.values()) if (msg.type === 'funding') m.set(msg.symbol, msg.rate * 100 * (8 / msg.periodHours));
      return m;
    },
  });
  engine.setInstructHandler((text) => {
    const r = talk.instruct(text);
    if (!r.ok) server.log.warn(`owner instruction not taken: ${r.reason}`);
  });
  server.get('/floor/talk', async () => talk.status());
  /** Start a conversation round now (the Desk's composer uses the socket instead, with the owner's words). */
  server.post('/floor/round', async (_req, reply) => {
    if (talk.status().running) return reply.code(409).send({ error: 'a round is already running' });
    void talk.runRound();
    return reply.code(202).send({ ok: true });
  });

  // ---- replay: run seats over past candles ---------------------------------------------------------------------------
  const replays = createReplayRunner({
    fetchJson: (url) => feedDeps.fetchJson(url),
    history: async (symbol, tf, from, to, isCancelled) => {
      const inst = instruments.find((i) => i.symbol === symbol);
      if (inst?.kind === 'stock') {
        const keys = alpacaKeys();
        if (!keys) throw new Error('stocks need an Alpaca key');
        const bars = await fetchStockBars(feedDeps.fetchJson, keys, symbol, tf, from, to, { isCancelled });
        if (!bars.length) throw new Error(`no historical bars for ${symbol} from Alpaca`);
        return { candles: bars.map((b) => ({ t: b.t, c: b.c })), source: 'alpaca' };
      }
      return fetchHistory((url) => feedDeps.fetchJson(url), symbol, tf, from, to, isCancelled, crypto);
    },
    // Stocks stop overnight and at weekends: fetch four days before the window so the first bar has a 24h-ago bar.
    warmupMs: (symbol) => (instruments.find((i) => i.symbol === symbol)?.kind === 'stock' ? 4 * 86_400_000 : 86_400_000),
    now: () => Date.now(),
    advisor,
    seatsFor: (roles) => {
      const want = roles?.map((r) => r.toUpperCase().replace(/\s+/g, ' ').trim());
      return engine.agents
        .filter((a) => a.config.trades && !a.external && (!want || want.includes(a.config.role.toUpperCase().replace(/\s+/g, ' ').trim())))
        .map((a) => ({
          role: a.config.role, name: a.config.name, model: a.config.model, temperature: a.config.temperature, mandate: a.config.mandate,
          maxClip: a.config.riskLimits.maxClip, usesModel: advisor.handles(a.config.model),
        }));
    },
  });
  const ReplayBody = z.object({
    symbol: z.string().min(1).max(16).refine((s) => engine.symbols().includes(s), { message: 'not an instrument on this floor' }),
    timeframe: z.enum(['1m', '5m', '15m', '1h']),
    days: z.number().int().min(1).max(30),
    horizon: z.number().int().min(1).max(96).default(3),
    feeBps: z.number().min(0).max(100).default(5),
    maxModelCalls: z.number().int().min(1).max(500).default(60),
    roles: z.array(z.string().min(1).max(64)).max(16).optional(),
  });
  server.post('/replay', async (req, reply) => {
    const parsed = ReplayBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const { roles, ...p } = parsed.data;
    const started = replays.start({ ...p, timeframe: p.timeframe as ReplayTf }, roles);
    if (!('id' in started)) return reply.code(started.error.includes('already') ? 409 : 400).send(started);
    return reply.code(202).send(started);
  });
  server.get('/replay', async () => ({ job: replays.current() }));
  server.get<{ Params: { id: string } }>('/replay/:id', async (req, reply) => replays.get(req.params.id) ?? reply.code(404).send({ error: 'not found' }));
  server.delete<{ Params: { id: string } }>('/replay/:id', async (req, reply) =>
    replays.cancel(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'no running replay with that id' }),
  );
  server.get<{ Params: { id: string } }>('/replay/:id/ideas.jsonl', async (req, reply) => {
    const rows = replays.ideas(req.params.id);
    if (!rows) return reply.code(404).send({ error: 'no finished replay with that id' });
    return reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bourse-replay-${req.params.id}.jsonl"`)
      .send(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  });

  /** Start every paper book and scorecard again from zero (seat settings stay). Not undoable: the Desk asks twice. */
  server.post('/paper/reset', async () => {
    engine.resetPaper();
    saveState();
    return { ok: true };
  });
  server.get('/scorecards', async () => ({ horizonMs: engine.scoreHorizonMs, scorecards: engine.scorecards() }));
  /** Recent ideas for one symbol, oldest first: what the Desk draws on its chart. */
  server.get<{ Querystring: { symbol?: string; limit?: string } }>('/ideas', async (req, reply) => {
    const symbol = req.query.symbol;
    if (symbol !== undefined && !engine.symbols().includes(symbol)) return reply.code(400).send({ error: `symbol must be one of ${engine.symbols().join(', ')}` });
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit ?? '200', 10) || 200));
    return engine.ideas().filter((r) => !symbol || r.symbol === symbol).slice(-limit);
  });
  /** This session's ideas as JSON Lines, one per idea, outcome null until it is scored. For evaluation or fine-tuning. */
  server.get<{ Querystring: { scored?: string } }>('/export/ideas.jsonl', async (req, reply) => {
    const onlyScored = req.query.scored === '1' || req.query.scored === 'true';
    const rows = engine.ideas().filter((r) => !onlyScored || r.outcome);
    return reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="bourse-ideas.jsonl"')
      .send(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  });
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
    if (msg.type === 'price') engine.pushTick(msg.symbol, { price: msg.price, change24h: msg.change24h, source: msg.source, ...(msg.marketOpen === undefined ? {} : { marketOpen: msg.marketOpen }) });
  };

  /** One poll, never overlapping the previous one. Exposed so tests can drive it. */
  const pollOnce = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const msgs = await pollFeeds(feedDeps, crypto);
      const keys = stockSymbols.length ? alpacaKeys() : undefined;
      if (keys) {
        try {
          const t = feedDeps.now();
          if (!clock || t - clock.at > 60_000) clock = { ...(await fetchClock(feedDeps.fetchJson, keys, t)), at: t };
          const open = clock.open;
          for (const q of await fetchStockQuotes(feedDeps.fetchJson, keys, stockSymbols, t)) msgs.push({ ...q, marketOpen: open });
        } catch (err) {
          server.log.warn(`stock quotes failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
      talk.start();
      return port;
    },
    async stop(): Promise<void> {
      stopped = true;
      talk.stop();
      clearInterval(saver);
      saveState();
      await ideaWrites;
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      for (const wss of [agentsWss, feedWss]) for (const ws of wss.clients) ws.terminate();
      agentsWss.close();
      feedWss.close();
      await server.close();
    },
  };
}
