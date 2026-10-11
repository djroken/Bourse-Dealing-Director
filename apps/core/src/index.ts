import Fastify, { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { registerAgentEngine } from './agentEngine';

type FeedSource = 'binance' | 'coinbase' | 'frankfurter' | 'hyperliquid';
interface PriceMsg {
  type: 'price';
  symbol: string;
  price: number;
  change24h: number | null;
  source: FeedSource;
  ts: number;
}
interface FundingMsg {
  type: 'funding';
  symbol: string;
  rate: number;
  ts: number;
}
type FeedMsg = PriceMsg | FundingMsg;

const HOST = process.env.CORE_HOST || [0, 0, 0, 0].join('.');
const PORT = Number(process.env.CORE_PORT || 4000);
const INTERVAL_MS = 5000;
const HTTP_TIMEOUT_MS = 6000;

const CRYPTO_SYMBOLS: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const DISPLAY: Record<string, string> = {
  BTCUSDT: 'BTC-USDT',
  ETHUSDT: 'ETH-USDT',
  SOLUSDT: 'SOL-USDT',
};
const FX_PAIRS: string[] = ['USD-EUR', 'USD-GBP', 'USD-JPY'];

async function fetchJsonWithRetries(url: string, opts: any = {}, retries = 2): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' for ' + url);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function fetchBinance(symbol: string): Promise<PriceMsg | null> {
  try {
    const data = await fetchJsonWithRetries('https://api.binance.com/api/v3/ticker?symbol=' + symbol);
    return {
      type: 'price',
      symbol: DISPLAY[symbol] || symbol,
      price: parseFloat(data.lastPrice),
      change24h: parseFloat(data.priceChangePercent),
      source: 'binance',
      ts: Date.now(),
    };
  } catch (err) {
    return null;
  }
}

async function fetchCoinbase(displaySymbol: string): Promise<PriceMsg | null> {
  const cbSymbol = displaySymbol.replace(/-([A-Z]+)$/, '-$1');
  try {
    const [ticker, stats] = await Promise.all([
      fetchJsonWithRetries('https://api.exchange.coinbase.com/products/' + cbSymbol + '/ticker'),
      fetchJsonWithRetries('https://api.exchange.coinbase.com/products/' + cbSymbol + '/stats'),
    ]);
    const price = parseFloat(ticker.price);
    const open = parseFloat(stats.open_24h);
    const change24h = open > 0 ? ((price - open) / open) * 100 : null;
    return {
      type: 'price',
      symbol: displaySymbol,
      price,
      change24h: change24h !== null ? Number(change24h.toFixed(2)) : null,
      source: 'coinbase',
      ts: Date.now(),
    };
  } catch (err) {
    return null;
  }
}

async function fetchFx(): Promise<PriceMsg[]> {
  try {
    const data = await fetchJsonWithRetries('https://api.frankfurter.app/latest?from=USD');
    const rates: Record<string, number> = data.rates || {};
    const out: PriceMsg[] = [];
    for (const pair of FX_PAIRS) {
      const fiat = pair.split('-')[1];
      const rate = rates[fiat];
      if (typeof rate === 'number') {
        out.push({ type: 'price', symbol: pair, price: rate, change24h: null, source: 'frankfurter', ts: Date.now() });
      }
    }
    return out;
  } catch (err) {
    return [];
  }
}

async function fetchFunding(): Promise<FundingMsg[]> {
  try {
    const data = await fetchJsonWithRetries('https://api.hyperliquid.info/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allFundingRates' }),
    });
    const out: FundingMsg[] = [];
    const rateMap: Record<string, string> = {};
    for (const entry of data) {
      const coin: string = entry.coin;
      const rate: string = entry.fundingRate;
      if (coin && rate !== undefined) rateMap[coin] = rate;
    }
    for (const coin of ['BTC', 'ETH', 'SOL']) {
      if (coin in rateMap) {
        out.push({ type: 'funding', symbol: coin, rate: parseFloat(rateMap[coin]), ts: Date.now() });
      }
    }
    return out;
  } catch (err) {
    return [];
  }
}

const server: FastifyInstance = Fastify({ logger: true });

let lastUpdate = 0;
let activeSymbols: string[] = [...Object.values(DISPLAY), ...FX_PAIRS];

server.get('/', async () => ({
  status: 'ok',
  service: 'hermes-market-data',
  port: PORT,
}));

server.get('/feeds', async () => ({
  intervalMs: INTERVAL_MS,
  symbols: activeSymbols,
  sources: ['binance', 'coinbase', 'frankfurter', 'hyperliquid'],
  lastUpdate,
}));

// Register the agent engine BEFORE listen — Fastify freezes routes on listen
registerAgentEngine(server).catch((err) => server.log.error('Agent engine failed: ' + (err as Error).message));

const start = async () => {
  try {
    await server.listen({ port: PORT, host: HOST });
    const addr = server.server.address();
    if (addr === null) {
      throw new Error('Server address is null');
    }
    const port = typeof addr === 'string' ? addr : addr.port;
    server.log.info('HTTP server listening on port ' + port);

    const wss = new WebSocketServer({ server: server.server });
    server.log.info('WebSocket server attached');

    const clients = new Set<WebSocket>();

    wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url || '', 'http://localhost').pathname;

      // Route /agents connections to the agent feed handler
      if (url === '/agents') {
        const handler = (server as any).floorHandleAgentConnection as ((ws: WebSocket) => void) | undefined;
        if (handler) handler(ws);
        return;
      }

      server.log.info('Client connected to feed');
      clients.add(ws);
      ws.on('close', () => {
        server.log.info('Client disconnected');
        clients.delete(ws);
      });
      ws.on('error', (err: Error) => {
        server.log.error('WebSocket error: ' + err.message);
        clients.delete(ws);
      });
    });

    const broadcast = (msg: FeedMsg) => {
      const payload = JSON.stringify(msg);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
      // Push price ticks into the agent engine so agents can react
      if (msg.type === 'price') {
        (server as any).floorPushFeed?.(msg.symbol, {
          price: msg.price,
          change24h: msg.change24h,
          source: msg.source,
        });
      }
    };

    const pollAll = async () => {
      try {
        const prices: FeedMsg[] = [];
        for (const sym of CRYPTO_SYMBOLS) {
          const fromBinance = await fetchBinance(sym);
          if (fromBinance) {
            prices.push(fromBinance);
          } else {
            const fromCoinbase = await fetchCoinbase(DISPLAY[sym]);
            if (fromCoinbase) prices.push(fromCoinbase);
          }
        }
        const fx = await fetchFx();
        prices.push(...fx);

        const funding = await fetchFunding();
        for (const f of funding) broadcast(f);

        const seen = new Set<string>();
        for (const p of prices) {
          if (!seen.has(p.symbol)) {
            seen.add(p.symbol);
            broadcast(p);
          }
        }
        lastUpdate = Date.now();
      } catch (err) {
        if (err instanceof Error) server.log.error('Feed poll error: ' + err.message);
        else server.log.error('Feed poll error: ' + String(err));
      }
    };

    await pollAll();
    const timer = setInterval(pollAll, INTERVAL_MS);
    process.on('SIGTERM', () => {
      server.log.info('Received SIGTERM, shutting down...');
      clearInterval(timer);
      wss.close();
      server.close();
    });
  } catch (err) {
    if (err instanceof Error) server.log.error(err.message);
    else server.log.error(String(err));
    process.exit(1);
  }
};

start();
