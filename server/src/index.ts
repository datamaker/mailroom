import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

import { assertProductionConfig, config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { initOidc } from './auth/oidc.js';
import { authPlugin } from './auth/plugin.js';
import { HttpError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { listRoutes } from './routes/lists.js';
import { subscriberRoutes } from './routes/subscribers.js';
import { campaignRoutes } from './routes/campaigns.js';
import { templateRoutes } from './routes/templates.js';
import { settingsRoutes } from './routes/settings.js';
import { statsRoutes } from './routes/stats.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes } from './routes/webhooks.js';
import { compatRoutes } from './routes/compat.js';
import { startWorker, stopWorker } from './jobs/worker.js';
import { purgeExpiredSessions } from './auth/service.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    // 뉴스레터 본문(블록 JSON + 인라인 이미지 data URI)이 커질 수 있다.
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
  });

  assertProductionConfig((msg) => app.log.warn(msg));

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });

  // 구독폼/수신거부는 일반 form POST 로 들어온다 — Fastify 기본 파서엔 없다.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );
  // SNS 는 본문이 JSON 인데 content-type 을 text/plain 으로 보낸다.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, detail: err.detail });
    }
    req.log.error(err);
    const status = (err as any).statusCode ?? 500;
    return reply.code(status).send({
      error: status === 500 ? 'internal_error' : 'error',
      message: status === 500 ? '서버 오류가 발생했습니다.' : err.message,
    });
  });

  // register() 로 감싸면 훅이 그 플러그인 스코프에만 걸린다 — 루트에 직접 붙인다.
  await authPlugin(app);

  app.get('/api/health', async () => {
    await pool.query('select 1');
    return { ok: true, version: '0.1.0', provider: config.send.provider };
  });

  await app.register(authRoutes);
  await app.register(listRoutes);
  await app.register(subscriberRoutes);
  await app.register(campaignRoutes);
  await app.register(templateRoutes);
  await app.register(settingsRoutes);
  await app.register(statsRoutes);
  await app.register(publicRoutes);
  await app.register(webhookRoutes);
  await app.register(compatRoutes);

  // 빌드된 web 을 같은 프로세스에서 서빙한다 (lookout 과 같은 배포 형태).
  const webDist = join(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
        return reply.code(404).send({ error: 'not_found', message: '없는 엔드포인트입니다.' });
      }
      return reply.sendFile('index.html');
    });
  }

  await migrate();
  await initOidc();
  startWorker();

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
