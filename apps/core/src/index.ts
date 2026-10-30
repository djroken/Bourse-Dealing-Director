import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopback, loadConfig } from './config';
import { buildServer } from './server';

// A .env file in the repo root (or apps/core) is read at start-up, so keys like OPENROUTER_API_KEY live in one place
// instead of being typed into every terminal. Variables already set in the environment win. .env is git-ignored.
const here = dirname(fileURLToPath(import.meta.url)); // apps/core/src
for (const f of [...new Set([resolve(here, '../../../.env'), resolve(here, '../.env')])]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    console.log(`read settings from ${f}`);
  }
}

const config = loadConfig();
let core: ReturnType<typeof buildServer>;
try {
  core = buildServer(config);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (!isLoopback(config.host)) {
  core.server.log.warn(
    `CORE_HOST=${config.host}: core has no authentication. Anyone who can reach this port can read the floor and halt the agents.`,
  );
}

core
  .start()
  .then((port) => core.server.log.info(`Bourse Core listening on http://${config.host}:${port}`))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });

const shutdown = (signal: string) => {
  core.server.log.info(`${signal} received, shutting down`);
  void core.stop().finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
