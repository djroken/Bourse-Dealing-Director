import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createEngine } from '../src/engine';
import { loadSnapshot, saveSnapshot } from '../src/persist';
import { createScorebook } from '../src/scorecard';
import { buildServer } from '../src/server';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bourse-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const px = (price: number, change24h = 3) => ({ price, change24h, source: 'binance' });

describe('engine snapshot and restore', () => {
  it('brings back paper books, seat settings, guests and scorecards', () => {
    const c = clock();
    const a = createEngine({ now: c.now, cooldownMs: 0 });
    a.pushTick('BTC-USDT', px(100)); // AUTO seats fill, everyone has ideas
    const quant = a.agents.find((x) => x.config.role === 'Quant / Signals')!;
    a.submitOrder(quant, 'BTC-USDT', 'BUY', 1, 'Approved by operator');
    const guest = a.registerGuest('Claude Bot')!;
    a.submitOrder(guest, 'BTC-USDT', 'SELL', 2, 'Placed by Claude Bot');
    quant.config.model = 'ollama:qwen3';
    quant.config.mandate = 'Only BTC.';
    const snap = JSON.parse(JSON.stringify(a.snapshot())); // through JSON, like the file

    const b = createEngine({ now: c.now, cooldownMs: 0 });
    b.restore(snap);
    const q2 = b.agents.find((x) => x.config.role === 'Quant / Signals')!;
    expect(q2.config).toMatchObject({ model: 'ollama:qwen3', mandate: 'Only BTC.' });
    expect(q2.book.positions.get('BTC-USDT')).toEqual(quant.book.positions.get('BTC-USDT'));
    const g2 = b.agents.find((x) => x.external)!;
    expect(g2.config.name).toBe('Claude Bot');
    expect(g2.book.positions.get('BTC-USDT')!.qty).toBe(-2);
    expect(b.scorecards().find((x) => x.agentId === g2.id)!.fills).toBe(1);
    expect(b.ideas().length).toBe(a.ideas().length);
    expect(b.scorecards().find((x) => x.role === 'Execution Trader')).toMatchObject({ ideas: 1, fills: 1 });

    // marks continue from the restored books
    b.pushTick('BTC-USDT', px(110));
    expect(b.positionsOf(q2).pnl).toBeCloseTo(10, 6);
  });

  it('keeps a paused seat paused, and skips roles it no longer has', () => {
    const a = createEngine();
    const snap = a.snapshot();
    snap.seats[0]!.paused = true;
    snap.seats.push({ role: 'Janitor', model: 'x', temperature: 0, autonomy: 'AUTO', mandate: '', paused: false });
    snap.books.push({ role: 'Janitor', realized: 5, positions: [] });
    const b = createEngine();
    b.restore(snap);
    expect(b.agents[0]!.state).toBe('paused');
    expect(b.agents.some((x) => x.config.role === 'Janitor')).toBe(false);
  });

  it('resetPaper zeroes every book and scorecard but keeps settings', () => {
    const e = createEngine({ cooldownMs: 0 });
    e.pushTick('BTC-USDT', px(100));
    const trader = e.agents.find((x) => x.config.role === 'Execution Trader')!;
    trader.config.model = 'ollama:llama3.2';
    expect(trader.book.positions.size).toBe(1);
    e.resetPaper();
    expect(trader.book.positions.size).toBe(0);
    expect(trader.dailyPnL).toBe(0);
    expect(e.ideas()).toHaveLength(0);
    expect(e.scorecards().every((x) => x.ideas === 0 && x.fills === 0)).toBe(true);
    expect(trader.config.model).toBe('ollama:llama3.2');
  });
});

describe('ideas that miss their horizon', () => {
  it('expire unscored instead of being scored on a much later price', () => {
    const c = clock();
    const sb = createScorebook({ now: c.now, horizonMs: 60_000 });
    sb.idea({ agentId: 'A', role: 'r', name: 'n', model: 'm', temperature: 0, autonomy: 'AUTO', symbol: 'BTC-USDT', side: 'BUY', size: 1, confidence: 0.5, rationale: '', price: 100, change24h: 1, source: 'binance' });
    c.advance(60_000 + 6 * 60_000); // past horizon + 5 min grace
    expect(sb.tick('BTC-USDT', 200)).toHaveLength(0);
    expect(sb.ideas()[0]).toMatchObject({ expired: true, outcome: null });
    expect(sb.cardOf('A')!.scored).toBe(0);
  });
});

describe('state file', () => {
  it('round-trips through disk with mode 600', () => {
    const d = tmp();
    const f = join(d, 'nested', 'state.json');
    const snap = createEngine().snapshot();
    saveSnapshot(f, snap);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadSnapshot(f)).toEqual({ kind: 'ok', snap: JSON.parse(JSON.stringify(snap)) });
    expect(loadSnapshot(join(d, 'missing.json'))).toEqual({ kind: 'none' });
  });
  it('moves a corrupt or tampered file aside instead of half-loading it', () => {
    const d = tmp();
    for (const body of ['{not json', JSON.stringify({ v: 2 }), JSON.stringify({ ...createEngine().snapshot(), books: [{ role: 'x', realized: 'lots', positions: [] }] })]) {
      const f = join(d, 'state.json');
      writeFileSync(f, body);
      const r = loadSnapshot(f, () => 42);
      expect(r.kind).toBe('bad');
      expect(existsSync(f)).toBe(false);
      expect(existsSync(join(d, 'state.json.bad-42'))).toBe(true);
      rmSync(join(d, 'state.json.bad-42'));
    }
  });
});

describe('server: paper state survives a restart', () => {
  const boot = (dataDir: string, extra: Record<string, unknown> = {}) =>
    buildServer(
      { ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1' }), feedIntervalMs: 60_000, dataDir, ideaLog: false, ...extra },
      { feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } },
    );

  it('saves on stop, restores on start, and POST /paper/reset clears it (allowed origins only)', async () => {
    const d = tmp();
    const one = boot(d);
    await one.start();
    one.engine.pushTick('BTC-USDT', px(100));
    const trader = one.engine.agents.find((x) => x.config.role === 'Execution Trader')!;
    const qty = trader.book.positions.get('BTC-USDT')!.qty;
    await one.stop();
    expect(existsSync(join(d, 'state.json'))).toBe(true);

    const two = boot(d);
    const port = await two.start();
    try {
      const t2 = two.engine.agents.find((x) => x.config.role === 'Execution Trader')!;
      expect(t2.book.positions.get('BTC-USDT')!.qty).toBe(qty);
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/paper/reset`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
      expect(t2.book.positions.size).toBe(1);
      const ok = await fetch(`${base}/paper/reset`, { method: 'POST', headers: { Origin: 'http://localhost:3000' } });
      expect(await ok.json()).toEqual({ ok: true });
      expect(t2.book.positions.size).toBe(0);
    } finally {
      await two.stop();
    }
    const three = boot(d);
    await three.start();
    expect(three.engine.agents.every((a) => a.book.positions.size === 0)).toBe(true);
    await three.stop();
  });

  it('BOURSE_PERSIST=off writes nothing', async () => {
    const d = tmp();
    expect(loadConfig({ BOURSE_PERSIST: 'off' }).persist).toBe(false);
    expect(loadConfig({}).persist).toBe(true);
    const s = boot(d, { persist: false });
    await s.start();
    s.engine.pushTick('BTC-USDT', px(100));
    await s.stop();
    expect(readdirSync(d)).toEqual([]);
  });
});

describe('the daily loss stop resets each UTC day', () => {
  it('counts only today, so a stopped seat can trade again tomorrow', () => {
    let t = Date.UTC(2026, 9, 18, 23, 0);
    const e = createEngine({ now: () => t, cooldownMs: 0 });
    e.pushTick('ETH-USDT', px(100, 0));
    const quant = e.agents.find((x) => x.config.role === 'Quant / Signals')!;
    const stop = quant.config.riskLimits.dailyLossStop;
    const size = Math.floor(quant.config.riskLimits.maxClip / 100);
    e.submitOrder(quant, 'ETH-USDT', 'BUY', size, 'Approved by operator');
    e.pushTick('ETH-USDT', px(100 - (stop * 2) / size, 0)); // loses twice the stop
    expect(e.submitOrder(quant, 'ETH-USDT', 'BUY', 1, 'Approved by operator')).toMatchObject({ ok: false, reason: expect.stringMatching(/loss stop/) });
    t = Date.UTC(2026, 9, 19, 0, 5); // next day, price unchanged
    e.pushTick('ETH-USDT', px(100 - (stop * 2) / size, 0));
    expect(quant.dailyPnL).toBeCloseTo(0, 6);
    expect(e.submitOrder(quant, 'ETH-USDT', 'BUY', 1, 'Approved by operator').ok).toBe(true);
    expect(e.positionsOf(quant).pnl).toBeLessThan(-stop); // the total record still shows the loss
  });
});
