import { existsSync } from 'node:fs';

export interface CoreConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  /** How often the market-data feed is polled. */
  feedIntervalMs: number;
  /** Where the encrypted secret store lives. */
  dataDir: string;
  /** Raw BOURSE_MASTER_KEY. Undefined disables the secret store. */
  masterKey?: string;
  /** Where Ollama listens. */
  ollamaHost: string;
  /** Bearer token for /mcp. Unset (or under 16 characters) leaves MCP switched off. */
  mcpToken?: string;
  /** Model calls per provider per UTC day (0 = unlimited). A runaway-loop guard; raise it if you want more. */
  modelDailyCap: { ollama: number; openrouter: number };
}

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/** The project used to be called Hermes. The old HERMES_* names keep working for now; BOURSE_* wins when both are set. */
function pick(env: NodeJS.ProcessEnv, name: `BOURSE_${string}`): string | undefined {
  return env[name]?.trim() || env[name.replace('BOURSE_', 'HERMES_')]?.trim() || undefined;
}

/** Existing installs keep their encrypted keys: use ./.hermes if it exists and ./.bourse does not. */
function dataDir(env: NodeJS.ProcessEnv): string {
  const set = pick(env, 'BOURSE_DATA_DIR');
  if (set) return set;
  return existsSync('.hermes') && !existsSync('.bourse') ? '.hermes' : '.bourse';
}

function capOf(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`daily cap must be a whole number >= 0, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = Number(env.CORE_PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CORE_PORT must be an integer between 0 and 65535, got "${env.CORE_PORT}"`);
  }
  const origins = (env.CORE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return {
    // Loopback by default: core has no authentication, so it must not listen on the network unless you decide it should.
    host: env.CORE_HOST?.trim() || '127.0.0.1',
    port,
    allowedOrigins: origins.length ? origins : DEFAULT_ORIGINS,
    feedIntervalMs: 5000,
    dataDir: dataDir(env),
    masterKey: pick(env, 'BOURSE_MASTER_KEY'),
    mcpToken: pick(env, 'BOURSE_MCP_TOKEN'),
    ollamaHost: env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434',
    modelDailyCap: { ollama: capOf(env.OLLAMA_DAILY_CAP, 0), openrouter: capOf(env.OPENROUTER_DAILY_CAP, 200) },
  };
}

export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
