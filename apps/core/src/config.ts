export interface CoreConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  /** How often the market-data feed is polled. */
  feedIntervalMs: number;
}

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

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
  };
}

export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
