import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildAuthUrl, cliClientId, handleCallback, oidcEnabled, verifyCliIdToken } from '../auth/oidc.js';
import { createSession, destroySession, upsertUserFromSso } from '../auth/service.js';
import { SESSION_COOKIE, setSessionCookie } from '../auth/plugin.js';
import { badRequest } from '../lib/errors.js';

/** state/verifier 는 짧게 사는 서버 메모리에 둔다(로그인 왕복 몇 분). */
const pending = new Map<string, { verifier: string; createdAt: number }>();

function sweep() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

export async function authRoutes(app: FastifyInstance) {
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
    const session = await createSession(user.id);
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
    if (!oidcEnabled()) throw badRequest('SSO가 설정되지 않았습니다.');
    sweep();
    const { url, state, codeVerifier } = await buildAuthUrl();
    pending.set(state, { verifier: codeVerifier, createdAt: Date.now() });
    return reply.redirect(url);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const entry = q.state ? pending.get(q.state) : undefined;
    if (!entry) throw badRequest('로그인 세션이 만료되었습니다. 다시 시도해 주세요.');
    pending.delete(q.state);

    const currentUrl = new URL(`${config.adminUrl}${req.url}`);
    const identity = await handleCallback(currentUrl, q.state, entry.verifier);
    const user = await upsertUserFromSso(identity.email, identity.name);
    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt);
    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
