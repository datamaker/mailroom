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

/** 공개 경로는 인증 훅을 통과시킨다 (구독폼·추적·웹훅·웹뷰). */
const PUBLIC_PREFIXES = [
  // /api/auth/me 와 /logout 은 훅을 타야 한다 — 세션을 못 읽으면 항상 로그아웃으로 보인다.
  '/api/auth/status',
  '/api/auth/oidc/',
  '/api/health',
  '/t/',
  '/u/',
  '/p/',
  '/w/',
  '/s/',
  '/c/',
  '/a/',
  '/api/public/',
  '/api/webhooks/',
];

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0];
    if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return;
    if (!url.startsWith('/api/') && !url.startsWith('/v1/')) return; // 정적 자산

    // 1) API 키 — CLI/서버 연동. 외부 연동 호환을 위해 AccessToken 헤더도 받는다.
    const auth = req.headers.authorization;
    const accessToken = req.headers['accesstoken'] ?? req.headers['access-token'];
    const raw =
      (typeof accessToken === 'string' && accessToken) ||
      (auth?.startsWith('Bearer ') ? auth.slice(7) : '');
    if (raw) {
      const actor = await actorFromApiKey(raw.trim());
      if (actor) {
        req.actor = actor;
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
    // 화이트리스트(PUBLIC_PREFIXES) 방식이어야 안전하다.
    if (!ANONYMOUS_OK.has(url)) throw unauthorized();
  });
}

/** 신원이 없어도 200 을 돌려줘야 하는 곳 (로그인 화면이 상태를 물어본다). */
const ANONYMOUS_OK = new Set(['/api/auth/me', '/api/auth/logout']);

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
