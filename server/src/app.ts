import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';

import { config } from './config.js';
import { VERSION } from './version.js';
import { pool } from './db/pool.js';
import { authPlugin, matchedRoute } from './auth/plugin.js';
import { HttpError } from './lib/errors.js';
import { authRoutes, type AuthRouteOptions } from './routes/auth.js';
import { configureGatehouseStatus, type GatehouseStatusOptions } from './auth/gatehouseStatus.js';
import { listRoutes } from './routes/lists.js';
import { subscriberRoutes } from './routes/subscribers.js';
import { campaignRoutes } from './routes/campaigns.js';
import { templateRoutes } from './routes/templates.js';
import { settingsRoutes } from './routes/settings.js';
import { statsRoutes } from './routes/stats.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes, type WebhookOptions } from './routes/webhooks.js';
import { compatRoutes } from './routes/compat.js';
import { assetRoutes } from './routes/assets.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** 빌드된 web 디렉터리. 없으면 정적 서빙을 하지 않는다. */
  webDist?: string;
  /** SES 웹훅이 바깥으로 나가는 부분(인증서 조회 등). 테스트에서 갈아 끼운다. */
  webhook?: WebhookOptions;
  /** 웹 SSO 가 IdP 와 주고받는 부분. 테스트에서 갈아 끼운다. */
  auth?: AuthRouteOptions;
  /** gatehouse 계정 상태 조회 설정. 테스트가 가짜 fetch 를 끼운다. 없으면 환경변수대로. */
  gatehouse?: GatehouseStatusOptions;
  /** 등록되는 라우트를 전부 받아 본다 — 테스트가 "공개 라우트 목록"을 통째로 대조하는 데 쓴다. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

/**
 * 라우트·훅을 전부 붙인 앱을 만든다. listen·마이그레이션·워커는 index.ts 가 한다 —
 * 테스트가 포트를 열지 않고 app.inject 로 같은 앱을 두드릴 수 있게 나눠 두었다.
 */
export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL || 'info' },
    // 뉴스레터 본문(블록 JSON + 인라인 이미지 data URI)이 커질 수 있다.
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
    // 기본값(true)이면 라우터가 경로를 ';' 에서 잘라 버려 `/api/lists;x/../a` 가
    // `/api/lists` 로 매칭된다. 앞단 프록시가 보는 경로와 어긋나므로 끈다.
    useSemicolonDelimiter: false,
  });
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  if (opts.gatehouse) configureGatehouseStatus(opts.gatehouse);

  await app.register(cookie);
  // origin:true + credentials 는 어떤 사이트에서든 인증된 요청을 보낼 수 있게 반사한다.
  // 우리 UI 는 같은 오리진에서 뜨므로 알고 있는 오리진만 허용한다.
  // 공개 주소(publicUrl)는 넣지 않는다 — 그 오리진은 가져온 HTML(웹에서 보기)을 내보내는 곳이라,
  // 거기서 도는 스크립트가 관리자 쿠키를 실어 API 를 부를 수 있게 해 줄 이유가 없다.
  // (관리 주소와 공개 주소가 같은 배포에서는 adminUrl 로 그대로 허용된다.)
  const allowedOrigins = new Set([config.adminUrl, ...(config.corsOrigins ?? [])].filter(Boolean));
  await app.register(cors, {
    credentials: true,
    origin(origin, cb) {
      // 서버 간 호출(Origin 없음)과 등록된 오리진만.
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) return cb(null, true);
      cb(null, false);
    },
  });
  // 이미지 업로드. 본문 자체는 bodyLimit 과 별개로 여기서 제한한다.
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

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

  // 공개 경로가 내보내는 HTML(웹뷰·구독폼·수신거부)에 보안 헤더를 건다.
  // 콘텐츠 자체는 사내 사용자가 만들지만, 가져온 HTML 에 뭐가 섞여 있을지는 알 수 없다.
  app.addHook('onSend', async (req, reply, payload) => {
    // 응답 종류를 브라우저가 추측하지 않게 한다 — JSON·CSV 가 HTML 로 해석되는 일을 막는다.
    reply.header('x-content-type-options', 'nosniff');
    // 원본 URL 이 아니라 매칭된 라우트로 본다 — `/%77/…` 처럼 인코딩해서 헤더를 피할 수 없게.
    const route = matchedRoute(req) ?? '';
    if (!/^\/(w|s|u|p|c)\//.test(route)) return payload;
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    // 웹에서 보기는 가져온 HTML 을 그대로 내보낸다. 관리 UI 와 같은 오리진일 수 있으므로
    // 스크립트를 끄고, sandbox 로 오리진을 떼어 낸다(쿠키·같은 오리진 API 에 닿지 못한다).
    // 링크(새 창 포함)·스타일·이미지·폼은 그대로 동작한다.
    reply.header('content-security-policy', route === '/w/:slug' ? WEBVIEW_CSP : PUBLIC_PAGE_CSP);
    return payload;
  });

  const health = async () => {
    await pool.query('select 1');
    return { ok: true, version: VERSION, provider: config.send.provider };
  };
  app.get('/api/health', health);
  // 컨테이너 헬스체크는 사내 서비스 전부 /healthz 로 맞춘다.
  app.get('/healthz', health);

  await app.register(authRoutes, opts.auth ?? {});
  await app.register(listRoutes);
  await app.register(subscriberRoutes);
  await app.register(campaignRoutes);
  await app.register(templateRoutes);
  await app.register(settingsRoutes);
  await app.register(statsRoutes);
  await app.register(publicRoutes);
  await app.register(webhookRoutes, opts.webhook ?? {});
  await app.register(compatRoutes);
  await app.register(assetRoutes);

  // 빌드된 web 을 같은 프로세스에서 서빙한다 (lookout 과 같은 배포 형태).
  const webDist = opts.webDist ?? join(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (looksLikeApiPath(req.url)) {
        return reply.code(404).send({ error: 'not_found', message: '없는 엔드포인트입니다.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** 공개 HTML 공통: 스크립트·플러그인·<base> 금지, 폼은 우리 서버로만. */
export const PUBLIC_PAGE_CSP = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
/** 웹에서 보기: 위에 더해 오리진 없는 sandbox. allow-scripts·allow-same-origin 은 주지 않는다. */
export const WEBVIEW_CSP =
  `${PUBLIC_PAGE_CSP}; sandbox allow-popups allow-popups-to-escape-sandbox allow-forms ` +
  'allow-top-navigation-by-user-activation';

/**
 * 404 를 JSON 으로 줄지 SPA(index.html)로 줄지 가른다. 여기는 이미 어떤 라우트에도
 * 매칭되지 않은 요청만 오므로 보안 경계는 아니다 — `/api%2Flists` 같은 변형에
 * SPA 껍데기 대신 404 를 돌려주려고 디코딩해서 본다.
 */
function looksLikeApiPath(rawUrl: string): boolean {
  let path = rawUrl.split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return true; // 깨진 인코딩은 화면 주소일 리 없다.
  }
  path = path.toLowerCase();
  return /^\/+(api|v1)(\/|;|$)/.test(path);
}
