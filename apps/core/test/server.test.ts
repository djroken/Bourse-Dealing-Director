import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config';
import { createEngine } from '../src/engine';
import { buildServer } from '../src/server';

const ORIGIN = 'http://localhost:3000';
const config = { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000 };

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
async function boot() {
  running = buildServer(config, { feedDeps, engine: createEngine({ cooldownMs: 0 }) });
  const port = await running.start();
  await running.pollOnce(); // returns at once if the startup poll is still in flight; the tests below wait on messages either way
  return { core: running, port, base: `http://127.0.0.1:${port}` };
}
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

type Msg = Record<string, unknown>;
/** The server sends immediately on connect, so the listener has to exist before 'open' fires. */
const connect = (url: string, origin?: string) =>
  new Promise<{ ws: WebSocket; msgs: Msg[] }>((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    const msgs: Msg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.once('open', () => resolve({ ws, msgs }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('config', () => {
  it('binds to loopback by default', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
  });
  it('rejects a bad port', () => {
    expect(() => loadConfig({ CORE_PORT: 'abc' })).toThrow(/CORE_PORT/);
    expect(() => loadConfig({ CORE_PORT: '70000' })).toThrow(/CORE_PORT/);
  });
  it('parses allowed origins', () => {
    expect(loadConfig({ CORE_ALLOWED_ORIGINS: ' https://a.test/ , https://b.test ' }).allowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('http', () => {
  it('health, agents list and a single agent', async () => {
    const { base } = await boot();
    expect(await (await fetch(base + '/')).json()).toMatchObject({ status: 'ok' });
    const list = (await (await fetch(base + '/agents')).json()) as Array<{ id: string }>;
    expect(list).toHaveLength(8);
    expect(await (await fetch(`${base}/agents/${list[0]!.id}`)).json()).toMatchObject({ id: 'TKT-001' });
  });

  it('returns a real 404 for an unknown agent', async () => {
    const { base } = await boot();
    const res = await fetch(base + '/agents/nope');
    expect(res.status).toBe(404);
  });

  it('halt-all then resume-all, from an allowed origin and from a tool with no Origin', async () => {
    const { base, core } = await boot();
    expect((await fetch(base + '/agents/halt-all', { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(200);
    expect(core.engine.agents.every((a) => a.state === 'halted')).toBe(true);
    expect((await fetch(base + '/agents/resume-all', { method: 'POST' })).status).toBe(200);
    expect(core.engine.agents.every((a) => a.state === 'running')).toBe(true);
  });

  it('refuses state-changing requests from an origin that is not allowed (CSRF)', async () => {
    const { base, core } = await boot();
    const res = await fetch(base + '/agents/halt-all', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(core.engine.agents.every((a) => a.state === 'running')).toBe(true);
  });

  it('sets CORS only for allowed origins and answers preflight', async () => {
    const { base } = await boot();
    const ok = await fetch(base + '/agents', { headers: { Origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await fetch(base + '/agents', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(base + '/agents/halt-all', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(pre.status).toBe(204);
  });
});

describe('websocket', () => {
  it('rejects a disallowed origin and an unknown path at upgrade', async () => {
    const { port } = await boot();
    await expect(connect(`ws://127.0.0.1:${port}/agents`, 'https://evil.example')).rejects.toThrow(/403/);
    await expect(connect(`ws://127.0.0.1:${port}/nope`, ORIGIN)).rejects.toThrow(/404/);
  });

  it('streams the agent floor: lifecycle on connect, intents after a poll, halt over the socket', async () => {
    const { port, core } = await boot();
    const { ws, msgs } = await connect(`ws://127.0.0.1:${port}/agents`, ORIGIN);
    await until(() => msgs.filter((m) => m.type === 'lifecycle').length >= 8);

    await core.pollOnce(); // canned BTC/ETH/SOL ticks
    await until(() => msgs.some((m) => m.type === 'intent'));
    expect(msgs.some((m) => m.type === 'decision')).toBe(true);

    ws.send(JSON.stringify({ type: 'halt_all' }));
    await until(() => msgs.some((m) => m.type === 'lifecycle' && m.agentId === '*' && m.status === 'halted'));
    expect(core.engine.agents.every((a) => a.state === 'halted')).toBe(true);
    ws.close();
  });

  it('serves the market feed and replays the latest prices to a late joiner', async () => {
    const { port, core } = await boot();
    await core.pollOnce();
    const { ws, msgs } = await connect(`ws://127.0.0.1:${port}/`, ORIGIN);
    await until(() => msgs.length >= 3);
    expect(msgs.filter((m) => m.type === 'price').map((m) => m.symbol).sort()).toEqual(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
    ws.close();
  });

  it('survives garbage from a client and keeps the connection open', async () => {
    const { port } = await boot();
    const { ws } = await connect(`ws://127.0.0.1:${port}/agents`, ORIGIN);
    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'subscribe' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('closes a client that sends an oversized frame', async () => {
    const { port } = await boot();
    const { ws } = await connect(`ws://127.0.0.1:${port}/agents`, ORIGIN);
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send('x'.repeat(64 * 1024));
    expect(await closed).toBe(1009);
  });
});

describe('config: legacy HERMES_* names', () => {
  it('still reads the old env names, and BOURSE_* wins when both are set', () => {
    expect(loadConfig({ HERMES_MCP_TOKEN: 'old-token-0123456789' }).mcpToken).toBe('old-token-0123456789');
    expect(loadConfig({ HERMES_MCP_TOKEN: 'old', BOURSE_MCP_TOKEN: 'new-token-0123456789' }).mcpToken).toBe('new-token-0123456789');
    expect(loadConfig({ HERMES_MASTER_KEY: 'k' }).masterKey).toBe('k');
    expect(loadConfig({ BOURSE_DATA_DIR: '/x' }).dataDir).toBe('/x');
    expect(loadConfig({ HERMES_DATA_DIR: '/y' }).dataDir).toBe('/y');
  });
});
