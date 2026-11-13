import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { gatehouseStatus } from './gatehouseStatus.js';

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

/**
 * 세션 수명.
 *   web — 유휴 24시간, 발급 후 최장 7일. 쓰는 동안은 expires_at 을 뒤로 민다(sliding).
 *   cli — 유휴 만료 없음, 발급 후 최장 7일. CLI·MCP 는 며칠에 한 번 쓰는 일이 흔하다.
 * 어느 쪽이든 gatehouse 에서 비활성화·세션 종료하면 1분 안에 끊긴다(gatehouseStatus).
 */
export type SessionKind = 'web' | 'cli';
const ABSOLUTE_MS = 7 * 86_400_000;
const IDLE_MS = 24 * 3_600_000;
/** 요청마다 UPDATE 하지 않도록, 남은 시간이 이만큼 줄었을 때만 민다. */
const SLIDE_AFTER_MS = 3_600_000;


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

export async function createSession(userId: string, kind: SessionKind = 'web') {
  const token = randomToken(32);
  const now = Date.now();
  const absolute = new Date(now + ABSOLUTE_MS);
  const expires = kind === 'web' ? new Date(now + IDLE_MS) : absolute;
  await query('insert into sessions (token_hash, user_id, expires_at, kind) values ($1, $2, $3, $4)', [
    sha256(token),
    userId,
    expires,
    kind,
  ]);
  // absoluteExpiresAt 은 쿠키 수명에 쓴다 — 서버가 유휴 만료를 따로 판단하므로 쿠키는 길게 둬도 된다.
  return { token, expiresAt: expires, absoluteExpiresAt: absolute };
}

export async function userFromSession(token: string): Promise<User | null> {
  const hash = sha256(token);
  const row = await one<User & { session_created_at: Date; session_expires_at: Date; session_kind: string }>(
    `select u.*, s.created_at as session_created_at, s.expires_at as session_expires_at, s.kind as session_kind
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.is_active`,
    [hash]
  );
  if (!row) return null;
  const { session_created_at: createdAt, session_expires_at: expiresAt, session_kind: kind, ...user } = row;

  // 사용자는 전부 SSO 로 만들어진다 — gatehouse 에서 회수됐는지 확인한다(이메일별 60초 캐시).
  const verdict = await gatehouseStatus().check(user.email, createdAt);
  if (verdict === 'inactive') {
    // 비활성화·삭제된 계정: 브라우저·CLI 세션을 전부 지운다.
    await query('delete from sessions where user_id = $1', [user.id]);
    return null;
  }
  if (verdict === 'revoked') {
    // "세션 종료" 이전에 발급된 세션들. 그 뒤에 새로 로그인한 세션은 살려 둔다.
    await query('delete from sessions where token_hash = $1', [hash]);
    return null;
  }

  // 유휴 만료를 뒤로 민다. 발급 후 7일은 넘기지 못한다.
  if (kind === 'web' && expiresAt.getTime() - Date.now() < IDLE_MS - SLIDE_AFTER_MS) {
    query(
      `update sessions
          set expires_at = least(created_at + ($2 || ' milliseconds')::interval,
                                 now() + ($3 || ' milliseconds')::interval)
        where token_hash = $1`,
      [hash, String(ABSOLUTE_MS), String(IDLE_MS)]
    ).catch(() => {});
  }
  return user as User;
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
