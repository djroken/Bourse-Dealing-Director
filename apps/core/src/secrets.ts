import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Encrypted-at-rest store for API keys and tokens.
 *
 * AES-256-GCM, one random 96-bit IV per write, the secret's id bound in as additional authenticated data so a
 * ciphertext can't be swapped between ids. The master key comes from BOURSE_MASTER_KEY or, when that isn't set, from a
 * local key file core creates on first run (see `localMasterKey`).
 * Values can be written and deleted over HTTP but are never returned by it: only the server-side execution layer
 * (which doesn't exist yet) calls `get`.
 */

export interface SecretMeta {
  id: string;
  updatedAt: number;
}
export interface SecretStore {
  set(id: string, value: string): SecretMeta;
  /** Server-side only. Deliberately not exposed by any route. */
  get(id: string): string | undefined;
  delete(id: string): boolean;
  list(): SecretMeta[];
}

interface Entry {
  iv: string;
  tag: string;
  ct: string;
  updatedAt: number;
}
interface FileShape {
  v: 1;
  secrets: Record<string, Entry>;
}

export const SECRET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_SECRET_LENGTH = 4096;

/** Accepts 64 hex characters or base64 that decodes to exactly 32 bytes. */
export function parseMasterKey(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  }
  throw new Error('BOURSE_MASTER_KEY must be 32 random bytes as 64 hex characters or base64. Generate one with: pnpm --filter core keygen');
}

const encrypt = (key: Buffer, id: string, plain: string): Omit<Entry, 'updatedAt'> => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
};
const decrypt = (key: Buffer, id: string, e: Entry): string => {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAAD(Buffer.from(id));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
};

export function openSecretStore(opts: { file: string; key: Buffer; now?: () => number }): SecretStore {
  const { file, key } = opts;
  const now = opts.now ?? Date.now;
  let data: FileShape = { v: 1, secrets: {} };

  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileShape;
    if (parsed?.v !== 1 || typeof parsed.secrets !== 'object' || parsed.secrets === null) {
      throw new Error(`${file} is not a Bourse secret store`);
    }
    data = parsed;
    // Fail loudly at startup if the key is wrong, not on first use.
    for (const [id, e] of Object.entries(data.secrets)) {
      try {
        decrypt(key, id, e);
      } catch {
        throw new Error(`Cannot decrypt ${file}: BOURSE_MASTER_KEY does not match the key it was written with`);
      }
    }
  }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* not supported on every platform */
    }
  };
  const checkId = (id: string) => {
    if (!SECRET_ID.test(id)) throw new Error('invalid secret id');
  };

  return {
    set(id, value) {
      checkId(id);
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_LENGTH) throw new Error('invalid secret value');
      const updatedAt = now();
      data.secrets[id] = { ...encrypt(key, id, value), updatedAt };
      persist();
      return { id, updatedAt };
    },
    get(id) {
      const e = Object.hasOwn(data.secrets, id) ? data.secrets[id] : undefined;
      return e ? decrypt(key, id, e) : undefined;
    },
    delete(id) {
      if (!Object.hasOwn(data.secrets, id)) return false;
      delete data.secrets[id];
      persist();
      return true;
    },
    list() {
      return Object.entries(data.secrets)
        .map(([id, e]) => ({ id, updatedAt: e.updatedAt }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

/**
 * When BOURSE_MASTER_KEY isn't set, use `<dataDir>/master.key`, creating it (0600) on a fresh install so saving a key in
 * Setup just works. This protects keys from casual copying of secrets.json, not from someone who can read the folder:
 * for that, set BOURSE_MASTER_KEY yourself and keep it off disk. Never creates a key next to an existing store it
 * couldn't open, since that would only make the old secrets unreadable.
 */
export function localMasterKey(dataDir: string): { key: string; created: boolean } | { error: string } {
  const keyFile = `${dataDir}/master.key`;
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile, 'utf8').trim();
    try {
      parseMasterKey(raw);
      return { key: raw, created: false };
    } catch {
      return { error: `${keyFile} is not a valid master key: fix or remove it` };
    }
  }
  if (existsSync(`${dataDir}/secrets.json`)) {
    return { error: `${dataDir}/secrets.json exists but there is no master key for it: set BOURSE_MASTER_KEY to the key it was made with` };
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyFile, key + '\n', { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* Windows: permissions are inherited from the folder */
  }
  return { key, created: true };
}
