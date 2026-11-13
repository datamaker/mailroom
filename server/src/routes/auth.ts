import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  buildAuthUrl,
  cliClientId,
  handleCallback,
  oidcEnabled,
  verifyCliIdToken,
  type OidcIdentity,
  type OidcStart,
} from '../auth/oidc.js';
import { createSession, destroySession, upsertUserFromSso } from '../auth/service.js';
import { SESSION_COOKIE, setSessionCookie } from '../auth/plugin.js';
import { badRequest } from '../lib/errors.js';
import { safeEqual, signPayload, verifyPayload } from '../lib/crypto.js';

/** state/verifier 는 짧게 사는 서버 메모리에 둔다(로그인 왕복 몇 분). */
const pending = new Map<string, { verifier: string; createdAt: number }>();

/**
 * state 를 로그인을 시작한 브라우저에 묶는 쿠키.
 *
 * state 를 서버 메모리에만 두면 "서버가 발급한 state 인가"만 확인된다. 공격자가 자기 계정으로
 * 로그인을 시작해 받은 콜백 주소(code+state)를 피해자에게 열게 하면, 피해자 브라우저가
 * 공격자 계정으로 로그인된다(로그인 CSRF). 쿠키는 시작한 브라우저에만 있으므로 막힌다.
 */
const STATE_COOKIE = 'mailroom_oidc';
const STATE_TTL_MS = 10 * 60_000;
const STATE_COOKIE_PATH = '/api/auth/oidc';

function stateCookieValue(state: string) {
  return signPayload(`${state}.${Date.now() + STATE_TTL_MS}`);
}

/** 서명·만료를 확인하고, 쿠키에 묶인 state 를 돌려준다. */
function stateFromCookie(value: string | undefined): string | null {
  const payload = value ? verifyPayload(value) : null;
  if (!payload) return null;
  const dot = payload.lastIndexOf('.');
  const expiresAt = Number(payload.slice(dot + 1));
  if (dot <= 0 || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return payload.slice(0, dot);
}

function sweep() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

/** 웹 로그인이 IdP 와 주고받는 부분. 테스트에서 갈아 끼운다. */
export interface OidcDriver {
  enabled(): boolean;
  buildAuthUrl(): Promise<OidcStart>;
  handleCallback(currentUrl: URL, state: string, codeVerifier: string): Promise<OidcIdentity>;
}

export interface AuthRouteOptions {
  oidc?: OidcDriver;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions = {}) {
  const web: OidcDriver = opts.oidc ?? { enabled: oidcEnabled, buildAuthUrl, handleCallback };

  /**
   * 로그인 화면이 버튼을 띄울지 결정하고, CLI 가 로컬 설정 없이 device flow 를
   * 시작할 수 있게 issuer 와 CLI 클라이언트 id 도 함께 준다.
   */
  app.get('/api/auth/status', async () => ({
    sso: oidcEnabled(),
    devAuth: Boolean(config.devAuthEmail),
    ...(oidcEnabled() ? { issuer: config.oidc.issuer, cliClientId: cliClientId() } : {}),
  }));

  /**
   * CLI SSO: CLI 가 IdP 와 device flow 를 끝내고 id_token 을 가져온다.
   * 여기서 검증하고 세션 토큰을 발급한다 — 웹 로그인과 같은 세션 테이블을 쓰므로
   * 사용자 비활성화나 세션 정리가 CLI 에도 그대로 적용된다.
   */
  app.post('/api/auth/cli/exchange', async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'sso_disabled', message: 'SSO가 설정되지 않았습니다.' });
    const { idToken } = (req.body ?? {}) as { idToken?: string };
    if (!idToken) throw badRequest('idToken이 필요합니다.');

    let identity;
    try {
      identity = await verifyCliIdToken(idToken);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'CLI SSO 교환 실패');
      return reply.code(403).send({ error: 'forbidden', message: 'SSO 로그인에 실패했습니다.' });
    }

    const user = await upsertUserFromSso(identity.email, identity.name);
    const session = await createSession(user.id, 'cli');
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.actor?.user) return { user: null };
    const { id, email, name, role } = req.actor.user;
    return { user: { id, email, name, role } };
  });

  app.get('/api/auth/oidc/start', async (req, reply) => {
    if (!web.enabled()) throw badRequest('SSO가 설정되지 않았습니다.');
    sweep();
    const { url, state, codeVerifier } = await web.buildAuthUrl();
    pending.set(state, { verifier: codeVerifier, createdAt: Date.now() });
    // 콜백은 IdP 에서 돌아오는 최상위 GET 이라 SameSite=Lax 쿠키가 실려 온다.
    reply.setCookie(STATE_COOKIE, stateCookieValue(state), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.adminUrl.startsWith('https'),
      path: STATE_COOKIE_PATH,
      maxAge: STATE_TTL_MS / 1000,
    });
    return reply.redirect(url);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const state = typeof q.state === 'string' ? q.state : '';
    // 이 브라우저가 시작한 로그인인지 먼저 본다. 아니면 state 를 소모하지도 않는다.
    const bound = stateFromCookie((req as any).cookies?.[STATE_COOKIE]);
    reply.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
    if (!state || !bound || !safeEqual(bound, state)) {
      throw badRequest('로그인 세션이 만료되었습니다. 다시 시도해 주세요.');
    }
    const entry = pending.get(state);
    if (!entry) throw badRequest('로그인 세션이 만료되었습니다. 다시 시도해 주세요.');
    pending.delete(state);

    const currentUrl = new URL(`${config.adminUrl}${req.url}`);
    let identity: OidcIdentity;
    try {
      identity = await web.handleCallback(currentUrl, state, entry.verifier);
    } catch (err) {
      // 코드 교환 실패, 확인되지 않은 이메일 등. 사유는 로그에만 남긴다.
      req.log.warn({ err: (err as Error).message }, 'SSO 콜백 실패');
      return reply.code(403).send({ error: 'forbidden', message: 'SSO 로그인에 실패했습니다.' });
    }
    const user = await upsertUserFromSso(identity.email, identity.name);
    const session = await createSession(user.id, 'web');
    // 쿠키는 최장 수명(7일)까지 둔다 — 유휴 24시간 만료는 서버가 세션 테이블로 판단한다.
    setSessionCookie(reply, session.token, session.absoluteExpiresAt);
    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
