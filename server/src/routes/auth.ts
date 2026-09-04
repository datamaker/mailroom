import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildAuthUrl, handleCallback, oidcEnabled } from '../auth/oidc.js';
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
  app.get('/api/auth/status', async () => ({
    sso: oidcEnabled(),
    devAuth: Boolean(config.devAuthEmail),
  }));

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

    const currentUrl = new URL(`${config.publicUrl}${req.url}`);
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
