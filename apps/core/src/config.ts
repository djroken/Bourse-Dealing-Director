export interface CoreConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  /** How often the market-data feed is polled. */
  feedIntervalMs: number;
  /** Where the encrypted secret store lives. */
  dataDir: string;
  /** Raw HERMES_MASTER_KEY. Undefined disables the secret store. */
  masterKey?: string;
  /** Where Ollama listens. */
  ollamaHost: string;
  /** Model calls per provider per UTC day (0 = unlimited). A runaway-loop guard; raise it if you want more. */
  modelDailyCap: { ollama: number; openrouter: number };
}

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

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
    dataDir: env.HERMES_DATA_DIR?.trim() || '.hermes',
    masterKey: env.HERMES_MASTER_KEY?.trim() || undefined,
    ollamaHost: env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434',
    modelDailyCap: { ollama: capOf(env.OLLAMA_DAILY_CAP, 0), openrouter: capOf(env.OPENROUTER_DAILY_CAP, 200) },
  };
}

export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
