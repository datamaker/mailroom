import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { actorFromApiKey, upsertUserFromSso, userFromSession, type Actor } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export const SESSION_COOKIE = 'mailroom_session';

/**
 * 인증 없이 열려 있는 라우트. 요청 URL 이 아니라 **매칭된 라우트 패턴**으로 판단한다.
 *
 * 예전에는 원본 URL 의 접두어(`/api/` 로 시작하는가)를 봤는데, 라우터는 경로를
 * 퍼센트 디코딩한 뒤에 매칭하므로 `/%61pi/lists` 가 검사를 건너뛰고 `/api/lists`
 * 핸들러에 닿았다(구독자 명단 유출). 라우터가 고른 패턴을 보면 둘이 어긋날 수 없다.
 *
 * 여기 없는 라우트는 전부 인증이 필요하다(기본 거부). 공개 라우트를 새로 만들면
 * 이 목록에 정확한 패턴을 추가해야 한다 — 빼먹으면 401 이 나므로 조용히 열리는 일은 없다.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // 로그인 흐름. /api/auth/me 와 /logout 은 훅을 타야 한다(아래 ANONYMOUS_OK).
  '/api/auth/status',
  '/api/auth/oidc/start',
  '/api/auth/oidc/callback',
  '/api/auth/cli/exchange',
  // 헬스체크
  '/api/health',
  '/healthz',
  // 추적 (오픈 픽셀, 클릭)
  '/t/o/:token',
  '/t/c/:token/:linkId',
  // 수신거부, 구독정보 변경, 웹에서 보기, 구독폼, 구독 확인, 이미지
  '/u/:token',
  '/p/:token',
  '/w/:slug',
  '/s/:slug',
  '/c/:token',
  '/a/:id',
  // 외부 구독 API, SES 이벤트(SNS 서명으로 따로 검증한다)
  '/api/public/lists/:slug/subscribe',
  '/api/webhooks/ses',
]);

/**
 * API 핸들러가 아닌 와일드카드 라우트.
 *   '/*' — @fastify/static 이 빌드된 web(SPA) 파일을 내주는 라우트
 *   '*'  — @fastify/cors 가 등록하는 OPTIONS 라우트(프리플라이트가 아니면 404)
 * 더 구체적인 라우트가 항상 먼저 매칭되므로 이 둘로는 API 핸들러에 닿을 수 없다.
 */
const NON_API_ROUTES: ReadonlySet<string> = new Set(['/*', '*']);

/** 신원이 없어도 200 을 돌려줘야 하는 곳 (로그인 화면이 상태를 물어본다). */
const ANONYMOUS_OK: ReadonlySet<string> = new Set(['/api/auth/me', '/api/auth/logout']);

/** 라우터가 고른 패턴. 매칭된 라우트가 없으면(404) undefined. */
export function matchedRoute(req: FastifyRequest): string | undefined {
  if (req.is404) return undefined;
  return req.routeOptions?.url;
}

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (req) => {
    const route = matchedRoute(req);
    // 매칭된 라우트가 없으면 404 핸들러(또는 SPA 폴백)로만 간다 — API 핸들러에 닿지 않는다.
    if (route === undefined) return;
    if (PUBLIC_ROUTES.has(route) || NON_API_ROUTES.has(route)) return;

    // 1) API 키 — CLI/서버 연동. 외부 연동 호환을 위해 AccessToken 헤더도 받는다.
    const auth = req.headers.authorization;
    const accessToken = req.headers['accesstoken'] ?? req.headers['access-token'];
    const raw =
      (typeof accessToken === 'string' && accessToken) ||
      (auth?.startsWith('Bearer ') ? auth.slice(7) : '');
    if (raw) {
      const token = raw.trim();
      const actor = await actorFromApiKey(token);
      if (actor) {
        req.actor = actor;
        return;
      }
      // CLI 가 SSO 로 로그인하면 API 키가 아니라 세션 토큰을 들고 온다.
      const ssoUser = await userFromSession(token);
      if (ssoUser) {
        req.actor = { user: ssoUser, apiKeyId: null, scopes: ['read', 'write', 'admin'] };
        return;
      }
    }

    // 2) 브라우저 세션
    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (token) {
      const user = await userFromSession(token);
      if (user) {
        req.actor = { user, apiKeyId: null, scopes: ['read', 'write', 'admin'] };
        return;
      }
    }

    // 3) 로컬 개발용 우회 — 프로덕션에서 켜면 인증이 통째로 열린다.
    if (config.devAuthEmail) {
      const user = await upsertUserFromSso(config.devAuthEmail, 'Dev User');
      req.actor = { user, apiKeyId: null, scopes: ['read', 'write', 'admin'] };
      return;
    }

    // 여기까지 왔으면 신원이 없다. 읽기 라우트마다 requireActor 를 부르는 대신
    // 한 곳에서 막는다 — 빼먹으면 구독자 명단이 통째로 열리기 때문에
    // 화이트리스트(PUBLIC_ROUTES) 방식이어야 안전하다.
    if (!ANONYMOUS_OK.has(route)) throw unauthorized();
  });
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function requireWrite(req: FastifyRequest): Actor {
  const actor = requireActor(req);
  if (!actor.scopes.includes('write')) throw forbidden('쓰기 권한이 없는 API 키입니다.');
  return actor;
}

export function requireAdmin(req: FastifyRequest): Actor {
  const actor = requireActor(req);
  if (actor.apiKeyId && actor.scopes.includes('admin')) return actor;
  if (actor.user && (actor.user.role === 'owner' || actor.user.role === 'admin')) return actor;
  throw forbidden('관리자만 할 수 있습니다.');
}

export function currentUserId(req: FastifyRequest): string | null {
  return req.actor?.user?.id ?? null;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.adminUrl.startsWith('https'),
    path: '/',
    expires: expiresAt,
  });
}
