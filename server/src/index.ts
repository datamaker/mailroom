import { assertProductionConfig, config } from './config.js';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { initOidc } from './auth/oidc.js';
import { startWorker, stopWorker } from './jobs/worker.js';
import { startRateLimitSweeper } from './lib/ratelimit.js';
import { purgeExpiredSessions } from './auth/service.js';

async function main() {
  const app = await buildApp();

  assertProductionConfig((msg) => app.log.warn(msg));

  await migrate();
  await initOidc();
  startWorker();
  startRateLimitSweeper();

  const sessionSweep = setInterval(() => purgeExpiredSessions().catch(() => {}), 3_600_000);
  sessionSweep.unref?.();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`mailroom 준비됨 — ${config.publicUrl}`);

  const shutdown = async () => {
    stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
