import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'admin' | 'member';
  is_active: boolean;
}

export interface Actor {
  user: User | null;
  apiKeyId: string | null;
  scopes: string[];
}

const SESSION_DAYS = 14;

/** SSO로 확인된 신원을 사용자로 승격/생성한다(JIT 프로비저닝). */
export async function upsertUserFromSso(email: string, name: string): Promise<User> {
  const lower = email.toLowerCase();
  const isBootstrapAdmin = config.adminEmails.includes(lower);

  const existing = await one<User>('select * from users where lower(email) = $1', [lower]);
  if (existing) {
    if (!existing.is_active) throw unauthorized('비활성화된 계정입니다.');
    await query('update users set name = coalesce($2, name), last_login_at = now() where id = $1', [
      existing.id,
      name,
    ]);
    if (isBootstrapAdmin && existing.role === 'member') {
      await query(`update users set role = 'owner' where id = $1`, [existing.id]);
      existing.role = 'owner';
    }
    return existing;
  }

  // 첫 사용자는 자동으로 owner — 부트스트랩 락아웃을 막는다.
  const { rows } = await query<{ count: number }>('select count(*)::int as count from users');
  const first = rows[0].count === 0;
  const role = first || isBootstrapAdmin ? 'owner' : 'member';

  const created = await one<User>(
    `insert into users (email, name, role, last_login_at)
     values ($1, $2, $3, now())
     returning *`,
    [lower, name, role]
  );
  return created!;
}

export async function createSession(userId: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [
    sha256(token),
    userId,
    expires,
  ]);
  return { token, expiresAt: expires };
}

export async function userFromSession(token: string): Promise<User | null> {
  const row = await one<User & { expires_at: Date }>(
    `select u.* from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.is_active`,
    [sha256(token)]
  );
  return row ?? null;
}

export async function destroySession(token: string) {
  await query('delete from sessions where token_hash = $1', [sha256(token)]);
}

export async function purgeExpiredSessions() {
  await query('delete from sessions where expires_at < now()');
}

const API_KEY_PREFIX = 'mrk_';

export async function createApiKey(name: string, createdBy: string | null, scopes: string[]) {
  const raw = API_KEY_PREFIX + randomToken(24);
  const row = await one(
    `insert into api_keys (name, key_hash, key_prefix, scopes, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, name, key_prefix, scopes, is_active, created_at`,
    [name, sha256(raw), raw.slice(0, 12), scopes, createdBy]
  );
  // 평문은 이 응답에서만 볼 수 있다.
  return { ...row, key: raw };
}

export async function actorFromApiKey(raw: string): Promise<Actor | null> {
  const row = await one<{ id: string; scopes: string[] }>(
    'select id, scopes from api_keys where key_hash = $1 and is_active',
    [sha256(raw)]
  );
  if (!row) return null;
  // 마지막 사용 시각은 감사용 — 실패해도 요청을 막지 않는다.
  query('update api_keys set last_used_at = now() where id = $1', [row.id]).catch(() => {});
  return { user: null, apiKeyId: row.id, scopes: row.scopes };
}
