import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createEngine } from '../src/engine';
import { openSecretStore, parseMasterKey } from '../src/secrets';
import { buildServer } from '../src/server';

const dir = () => mkdtempSync(join(tmpdir(), 'bourse-secrets-'));
const key = () => randomBytes(32);

describe('parseMasterKey', () => {
  it('accepts 64 hex and 32-byte base64', () => {
    const k = key();
    expect(parseMasterKey(k.toString('hex')).equals(k)).toBe(true);
    expect(parseMasterKey(k.toString('base64')).equals(k)).toBe(true);
  });
  it.each(['', 'short', 'z'.repeat(64), randomBytes(16).toString('hex'), randomBytes(31).toString('base64')])('rejects %j', (bad) => {
    expect(() => parseMasterKey(bad)).toThrow(/BOURSE_MASTER_KEY/);
  });
});

describe('secret store', () => {
  it('round-trips, and the file never contains the plaintext', () => {
    const file = join(dir(), 's.json');
    const s = openSecretStore({ file, key: key() });
    s.set('anthropic.key', 'sk-ant-VERY-SECRET-123');
    expect(s.get('anthropic.key')).toBe('sk-ant-VERY-SECRET-123');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('VERY-SECRET');
    expect(raw).not.toContain('sk-ant');
  });
  it('persists across reopen with the same key and refuses a different key', () => {
    const file = join(dir(), 's.json');
    const k = key();
    openSecretStore({ file, key: k }).set('a', 'one');
    expect(openSecretStore({ file, key: k }).get('a')).toBe('one');
    expect(() => openSecretStore({ file, key: key() })).toThrow(/does not match/);
  });
  it('uses a fresh IV each write', () => {
    const file = join(dir(), 's.json');
    const s = openSecretStore({ file, key: key() });
    s.set('a', 'same');
    const first = readFileSync(file, 'utf8');
    s.set('a', 'same');
    expect(readFileSync(file, 'utf8')).not.toBe(first);
  });
  it('detects tampering and ciphertext swapped between ids', () => {
    const file = join(dir(), 's.json');
    const k = key();
    const s = openSecretStore({ file, key: k });
    s.set('a', 'alpha');
    s.set('b', 'beta');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.secrets.a = j.secrets.b; // swap
    writeFileSync(file, JSON.stringify(j));
    expect(() => openSecretStore({ file, key: k })).toThrow(/does not match/);
  });
  it('lists metadata only, deletes, and validates input', () => {
    const s = openSecretStore({ file: join(dir(), 's.json'), key: key(), now: () => 42 });
    s.set('b.x', 'v');
    s.set('a.x', 'v');
    expect(s.list()).toEqual([{ id: 'a.x', updatedAt: 42 }, { id: 'b.x', updatedAt: 42 }]);
    expect(s.delete('a.x')).toBe(true);
    expect(s.delete('a.x')).toBe(false);
    expect(s.get('a.x')).toBeUndefined();
    expect(() => s.set('../etc', 'v')).toThrow();
    expect(() => s.set('ok', '')).toThrow();
    expect(() => s.set('ok', 'x'.repeat(5000))).toThrow();
    expect(s.get('__proto__')).toBeUndefined();
  });
});

describe('/secrets routes', () => {
  let running: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });
  const boot = async (withKey: boolean) => {
    const config = {
      ...loadConfig({ CORE_PORT: '0', CORE_HOST: '127.0.0.1', BOURSE_DATA_DIR: dir(), ...(withKey ? { BOURSE_MASTER_KEY: key().toString('hex') } : {}) }),
      feedIntervalMs: 60_000,
    };
    running = buildServer(config, { engine: createEngine(), feedDeps: { now: Date.now, fetchJson: async () => { throw new Error('offline'); } } });
    const port = await running.start();
    return `http://127.0.0.1:${port}`;
  };
  const ORIGIN = { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' };

  it('stores a value, then reports that it exists without ever returning it', async () => {
    const base = await boot(true);
    const put = await fetch(`${base}/secrets/openai.key`, { method: 'PUT', headers: ORIGIN, body: JSON.stringify({ value: 'sk-TOPSECRET' }) });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain('TOPSECRET');
    const list = await fetch(`${base}/secrets`).then((r) => r.text());
    expect(list).not.toContain('TOPSECRET');
    expect(JSON.parse(list)).toMatchObject({ enabled: true, secrets: [{ id: 'openai.key' }] });
    expect((await fetch(`${base}/secrets/openai.key`)).status).toBe(404); // no GET of a single value
    expect((await fetch(`${base}/secrets/openai.key`, { method: 'DELETE', headers: ORIGIN })).status).toBe(200);
    expect(JSON.parse(await fetch(`${base}/secrets`).then((r) => r.text())).secrets).toEqual([]);
  });
  it('rejects writes from a foreign origin', async () => {
    const base = await boot(true);
    const r = await fetch(`${base}/secrets/x`, { method: 'PUT', headers: { ...ORIGIN, Origin: 'https://evil.example' }, body: JSON.stringify({ value: 'v' }) });
    expect(r.status).toBe(403);
    expect((await fetch(`${base}/secrets/x`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('validates ids and values', async () => {
    const base = await boot(true);
    const put = (id: string, body: unknown) => fetch(`${base}/secrets/${id}`, { method: 'PUT', headers: ORIGIN, body: JSON.stringify(body) });
    expect((await put('bad%20id', { value: 'v' })).status).toBe(400);
    expect((await put('ok', { value: '' })).status).toBe(400);
    expect((await put('ok', { value: 5 })).status).toBe(400);
    expect((await put('ok', {})).status).toBe(400);
  });
  it('is disabled with a clear message when no master key is set', async () => {
    const base = await boot(false);
    expect(JSON.parse(await fetch(`${base}/secrets`).then((r) => r.text()))).toEqual({ enabled: false, secrets: [] });
    const r = await fetch(`${base}/secrets/x`, { method: 'PUT', headers: ORIGIN, body: JSON.stringify({ value: 'v' }) });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('BOURSE_MASTER_KEY');
  });
});
