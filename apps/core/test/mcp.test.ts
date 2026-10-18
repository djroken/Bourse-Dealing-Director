import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config';
import { createEngine } from '../src/engine';
import { tokenOk } from '../src/mcp';
import { buildServer } from '../src/server';

const TOKEN = 'test-token-0123456789abcdef';
const canned: Record<string, unknown> = {
  'ticker/24hr?symbol=BTCUSDT': { lastPrice: '100', priceChangePercent: '3' },
  'ticker/24hr?symbol=ETHUSDT': { lastPrice: '10', priceChangePercent: '-2' },
  'ticker/24hr?symbol=SOLUSDT': { lastPrice: '1', priceChangePercent: '1' },
};
const feedDeps = {
  now: () => Date.now(),
  fetchJson: async (url: string) => {
    for (const [k, v] of Object.entries(canned)) if (url.includes(k)) return v;
    throw new Error('offline');
  },
};

let running: ReturnType<typeof buildServer> | undefined;
const clients: Client[] = [];
async function boot(mcpToken: string | null = TOKEN) {
  const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, mcpToken: mcpToken ?? undefined, persist: false, ideaLog: false };
  running = buildServer(config, { feedDeps, engine: createEngine({ cooldownMs: 0 }) });
  const port = await running.start();
  await running.pollOnce();
  await new Promise((r) => setTimeout(r, 100));
  return { core: running, base: `http://127.0.0.1:${port}` };
}
async function connect(base: string, agent = 'Test Bot', token = TOKEN) {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Bourse-Agent': agent } } }));
  clients.push(c);
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await running?.stop();
  running = undefined;
});

describe('tokenOk', () => {
  it('needs a long enough configured token and an exact bearer match', () => {
    expect(tokenOk(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(tokenOk(TOKEN, `Bearer ${TOKEN}x`)).toBe(false);
    expect(tokenOk(TOKEN, TOKEN)).toBe(false);
    expect(tokenOk(TOKEN, undefined)).toBe(false);
    expect(tokenOk('short', 'Bearer short')).toBe(false);
    expect(tokenOk(undefined, 'Bearer x')).toBe(false);
  });
});

describe('/mcp access', () => {
  it('is off without a token', async () => {
    const { base } = await boot(null);
    const r = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(r.status).toBe(503);
  });
  it('rejects a missing or wrong token, browsers (Origin) and non-POST', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope-nope-nope-nope' } })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://localhost:3000' } })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect(running!.engine.agents.some((a) => a.external)).toBe(false); // nobody got a seat
  });
});

describe('guest agent over MCP', () => {
  it('still accepts the old X-Hermes-Agent header', async () => {
    const { base, core } = await boot();
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Hermes-Agent': 'Legacy Bot' } } }));
    clients.push(c);
    await c.listTools();
    expect(core.engine.agents.find((a) => a.external)!.config.role).toBe('Guest: Legacy Bot');
  });

  it('lists the six tools', async () => {
    const { base } = await boot();
    const c = await connect(base);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_positions', 'get_quotes', 'get_risk', 'place_order', 'post_to_floor', 'read_floor']);
  });

  it('trades a paper book on live prices and sees its own P&L', async () => {
    const { base } = await boot();
    const c = await connect(base);
    const q = await call(c, 'get_quotes');
    expect(q.body.quotes.find((x: any) => x.symbol === 'BTC-USDT').price).toBe(100);
    const o = await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 10 });
    expect(o.isError).toBe(false);
    expect(o.body).toMatchObject({ ok: true, paper: true, price: 100, size: 10 });
    const p = await call(c, 'get_positions');
    expect(p.body.positions).toEqual([{ symbol: 'BTC-USDT', qty: 10, avgPx: 100, markPx: 100 }]);
    const r = await call(c, 'get_risk');
    expect(r.body).toMatchObject({ paperCapital: 100000, maxExposure: 300000, exposure: 1000, limits: { maxClip: 5000, maxLeverage: 3, dailyLossStop: 1000 } });
  });

  it('rejects, rather than resizes, orders over the limits', async () => {
    const { base } = await boot();
    const c = await connect(base);
    const big = await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 51 }); // $5,100 > $5,000 clip
    expect(big.isError).toBe(true);
    expect(big.body.reason).toContain('over the $5000 clip');
    expect((await call(c, 'get_positions')).body.positions).toEqual([]);
    expect((await c.callTool({ name: 'place_order', arguments: { symbol: 'DOGE-USDT', side: 'BUY', size: 1 } }) as any).isError).toBe(true);
    expect((await c.callTool({ name: 'place_order', arguments: { symbol: 'BTC-USDT', side: 'BUY', size: -1 } }) as any).isError).toBe(true);
  });

  it('caps total exposure at 3x the paper book but always lets it reduce', async () => {
    const { base, core } = await boot();
    const c = await connect(base);
    // $5,000 clips on BTC at $100: 50 units each. 60 clips would be $300k; the 61st goes over.
    for (let i = 0; i < 60; i++) expect((await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 50 })).isError).toBe(false);
    const over = await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 1 });
    expect(over.isError).toBe(true);
    expect(over.body.reason).toContain('exposure');
    expect((await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'SELL', size: 50 })).isError).toBe(false);
    expect(core.engine.agents.find((a) => a.external)!.book.positions.get('BTC-USDT')!.qty).toBe(2950);
  });

  it('is halted by HALT ALL like every other seat', async () => {
    const { base, core } = await boot();
    const c = await connect(base);
    core.engine.haltAll();
    const o = await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 1 });
    expect(o.isError).toBe(true);
    expect(o.body.reason).toContain('halted');
    core.engine.resumeAll();
    expect((await call(c, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 1 })).isError).toBe(false);
  });

  it('gets one seat per name, and a separate book per agent', async () => {
    const { base, core } = await boot();
    const a = await connect(base, 'Alpha');
    const a2 = await connect(base, 'Alpha');
    const b = await connect(base, 'Beta');
    await call(a, 'place_order', { symbol: 'BTC-USDT', side: 'BUY', size: 1 });
    expect((await call(a2, 'get_positions')).body.positions).toHaveLength(1); // same agent, new connection
    expect((await call(b, 'get_positions')).body.positions).toHaveLength(0);
    expect(core.engine.agents.filter((x) => x.external).map((x) => x.config.role)).toEqual(['Guest: Alpha', 'Guest: Beta']);
  });

  it('cleans odd names and caps the number of guests', async () => {
    const { base, core } = await boot();
    await connect(base, '<script>alert(1)</script>');
    expect(core.engine.agents.find((x) => x.external)!.config.name).toBe('scriptalert1script');
    for (let i = 0; i < 7; i++) await connect(base, `Bot ${i}`);
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Bourse-Agent': 'One too many', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(429);
  });

  it('shows up on the /agents stream: seat, fill and chat', async () => {
    const { base, core } = await boot();
    const port = new URL(base).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agents`, { headers: { Origin: 'http://localhost:3000' } });
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    const c = await connect(base, 'Streamer');
    await call(c, 'place_order', { symbol: 'ETH-USDT', side: 'SELL', size: 5 });
    expect((await call(c, 'post_to_floor', { text: 'Fading the dip \u0007 <b>now</b>' })).isError).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(got.find((m) => m.type === 'config' && m.role === 'Guest: Streamer')).toBeTruthy();
    expect(got.find((m) => m.type === 'decision' && m.role === 'Guest: Streamer' && m.action === 'SELL')).toBeTruthy();
    expect(got.find((m) => m.type === 'chat')).toMatchObject({ name: 'Streamer', text: 'Fading the dip <b>now</b>' });
    const floor = await call(c, 'read_floor', { limit: 5 });
    expect(floor.body.events.length).toBeGreaterThan(0);
    ws.close();
    void core;
  });

  it('rate-limits floor chat', async () => {
    const { base } = await boot();
    const c = await connect(base);
    for (let i = 0; i < 5; i++) expect((await call(c, 'post_to_floor', { text: `m${i}` })).isError).toBe(false);
    expect((await call(c, 'post_to_floor', { text: 'm6' })).isError).toBe(true);
  });
});
