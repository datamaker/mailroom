import type { FastifyInstance } from 'fastify';
import { promises as dns } from 'node:dns';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { currentUserId, requireAdmin, requireWrite } from '../auth/plugin.js';
import { createApiKey } from '../auth/service.js';
import { config } from '../config.js';

export async function settingsRoutes(app: FastifyInstance) {
  // ---- 발신자 주소 ----
  app.get('/api/senders', async () => ({
    senders: await many('select * from senders order by email'),
  }));

  app.post('/api/senders', async (req) => {
    requireWrite(req);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.email) throw badRequest('이메일 주소가 필요합니다.');
    const sender = await one(
      `insert into senders (email, name) values (lower($1), $2)
       on conflict (lower(email)) do update set name = coalesce(excluded.name, senders.name)
       returning *`,
      [b.email, b.name ?? null]
    );
    return { sender };
  });

  /** SPF/DKIM/DMARC 를 DNS에서 직접 확인한다 (스티비 발신자 관리의 새로고침). */
  app.post('/api/senders/:id/verify', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const sender = await one<{ email: string }>('select email from senders where id = $1', [id]);
    if (!sender) throw notFound('발신자를 찾을 수 없습니다.');
    const domain = sender.email.split('@')[1];
    const checks = await checkDomainAuth(domain);
    const updated = await one(
      `update senders set spf = $2, dkim = $3, dmarc = $4, verified = $5, checked_at = now()
        where id = $1 returning *`,
      [id, checks.spf, checks.dkim, checks.dmarc, checks.spf && checks.dmarc]
    );
    return { sender: updated, checks };
  });

  app.delete('/api/senders/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    await query('delete from senders where id = $1', [id]);
    return { ok: true };
  });

  // ---- API 키 ----
  app.get('/api/keys', async (req) => {
    requireAdmin(req);
    return {
      keys: await many(
        'select id, name, key_prefix, scopes, is_active, created_at, last_used_at from api_keys order by created_at desc'
      ),
    };
  });

  app.post('/api/keys', async (req) => {
    requireAdmin(req);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.name) throw badRequest('키 이름이 필요합니다.');
    const scopes: string[] = Array.isArray(b.scopes) && b.scopes.length ? b.scopes : ['read', 'write'];
    // 평문 키는 이 응답에서만 보인다 — 이후에는 해시만 남는다.
    const key = await createApiKey(b.name, currentUserId(req), scopes);
    return { key };
  });

  app.patch('/api/keys/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    const key = await one(
      `update api_keys set name = coalesce($2, name), is_active = coalesce($3, is_active) where id = $1
       returning id, name, key_prefix, scopes, is_active, created_at, last_used_at`,
      [id, b.name ?? null, b.is_active ?? null]
    );
    if (!key) throw notFound('API 키를 찾을 수 없습니다.');
    return { key };
  });

  app.delete('/api/keys/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await query('delete from api_keys where id = $1', [id]);
    return { ok: true };
  });

  // ---- 사용자 ----
  app.get('/api/users', async (req) => {
    requireAdmin(req);
    return {
      users: await many('select id, email, name, role, is_active, created_at, last_login_at from users order by created_at'),
    };
  });

  app.patch('/api/users/:id', async (req) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    // 자기 자신을 강등/비활성화해 락아웃되는 것을 막는다.
    if (actor.user?.id === id && (b.role === 'member' || b.is_active === false)) {
      throw badRequest('자기 자신의 권한은 낮출 수 없습니다.');
    }
    const user = await one(
      `update users set role = coalesce($2, role), is_active = coalesce($3, is_active) where id = $1
       returning id, email, name, role, is_active`,
      [id, b.role ?? null, b.is_active ?? null]
    );
    if (!user) throw notFound('사용자를 찾을 수 없습니다.');
    if (b.is_active === false) await query('delete from sessions where user_id = $1', [id]);
    return { user };
  });

  // ---- 수신 차단 목록 ----
  app.get('/api/suppressions', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit) || 100, 1000);
    return {
      suppressions: await many(
        `select * from suppressions ${q.q ? 'where email ilike $1' : ''} order by created_at desc limit ${limit}`,
        q.q ? [`%${q.q}%`] : []
      ),
    };
  });

  app.delete('/api/suppressions/:email', async (req) => {
    requireAdmin(req);
    const { email } = req.params as { email: string };
    await query('delete from suppressions where lower(email) = lower($1)', [decodeURIComponent(email)]);
    return { ok: true };
  });

  app.get('/api/settings', async () => ({
    publicUrl: config.publicUrl,
    adminUrl: config.adminUrl,
    sendProvider: config.send.provider,
    sesRegion: config.send.ses.region,
    rateLimit: config.send.rateLimit,
    ssoEnabled: config.oidc.enabled,
  }));
}

async function checkDomainAuth(domain: string) {
  const out = { spf: false, dkim: false, dmarc: false };
  try {
    const txt = await dns.resolveTxt(domain);
    out.spf = txt.some((chunks) => chunks.join('').toLowerCase().startsWith('v=spf1'));
  } catch {
    /* 레코드 없음 = 미설정 */
  }
  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`);
    out.dmarc = txt.some((chunks) => chunks.join('').toLowerCase().startsWith('v=dmarc1'));
  } catch {
    /* 미설정 */
  }
  // SES DKIM 은 CNAME 3개(<token>._domainkey)라 셀렉터를 모르면 직접 못 본다.
  // 도메인에 _domainkey 하위가 하나라도 있으면 설정된 것으로 본다.
  for (const selector of ['default', 'selector1', 'ses', 'stibee', 'google']) {
    try {
      await dns.resolveTxt(`${selector}._domainkey.${domain}`);
      out.dkim = true;
      break;
    } catch {
      /* 다음 셀렉터 */
    }
  }
  return out;
}
