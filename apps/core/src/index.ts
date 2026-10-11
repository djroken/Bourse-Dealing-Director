import { isLoopback, loadConfig } from './config';
import { buildServer } from './server';

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
  .then((port) => core.server.log.info(`Hermes Core listening on http://${config.host}:${port}`))
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
