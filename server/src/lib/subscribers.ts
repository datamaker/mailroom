import { many, one, query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export interface UpsertInput {
  email: string;
  fields?: Record<string, unknown>;
  adAgreed?: boolean;
  groupIds?: string[];
  source?: string;
  /** 구독 확인 대기 상태로 넣을지 */
  pending?: boolean;
  /**
   * 'MANUAL'  — 운영자가 넣음. 수신거부 상태는 존중해서 되살리지 않는다.
   * 'SUBSCRIBER' — 본인이 구독폼으로 신청. 수신거부였어도 다시 구독 중으로 바꾼다.
   */
  by?: 'MANUAL' | 'SUBSCRIBER';
  /** 값이 빈 필드를 기존 값 삭제로 볼지 (스티비의 "빈 값으로 업데이트" 체크박스) */
  clearEmpty?: boolean;
  /** 이관 시 원래 상태를 그대로 가져올 때. 지정하면 by 규칙보다 우선한다. */
  status?: 'subscribed' | 'unsubscribed' | 'deleted' | 'pending';
  /** 이관 시 원래 구독일 보존 */
  subscribedAt?: string | Date | null;
  /** 이름으로 지정한 그룹 — 없으면 만든다 */
  groupNames?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email: string) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email: string) {
  return EMAIL_RE.test(email);
}

export interface UpsertOutcome {
  id: string | null;
  email: string;
  result: 'created' | 'updated' | 'skipped';
  reason?: string;
}

export async function upsertSubscriber(listId: string, input: UpsertInput): Promise<UpsertOutcome> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { id: null, email, result: 'skipped', reason: '올바르지 않은 이메일 주소' };

  const existing = await one<{ id: string; status: string; fields: Record<string, unknown> }>(
    'select id, status, fields from subscribers where list_id = $1 and lower(email) = $2',
    [listId, email]
  );

  const incoming = { ...(input.fields ?? {}) };
  delete (incoming as any).email;

  const groupIds = [...(input.groupIds ?? [])];
  if (input.groupNames?.length) groupIds.push(...(await ensureGroups(listId, input.groupNames)));

  if (existing) {
    // 스티비와 같은 규칙: 운영자가 넣은 건 수신거부를 되살리지 않는다.
    let status = existing.status;
    if (input.status) {
      status = input.status;
    } else if (input.by === 'SUBSCRIBER' && (status === 'unsubscribed' || status === 'deleted')) {
      status = input.pending ? 'pending' : 'subscribed';
    } else if (status === 'deleted' && input.by !== 'SUBSCRIBER') {
      return { id: existing.id, email, result: 'skipped', reason: '자동삭제된 구독자' };
    }

    const merged = input.clearEmpty
      ? incoming
      : { ...existing.fields, ...pruneEmpty(incoming) };

    await query(
      `update subscribers
          set fields = $2::jsonb,
              ad_agreed = coalesce($3, ad_agreed),
              status = $4,
              subscribed_at = coalesce($5::timestamptz,
                case when status <> 'subscribed' and $4 = 'subscribed' then now() else subscribed_at end),
              unsubscribed_at = case when $4 = 'subscribed' then null else unsubscribed_at end,
              updated_at = now()
        where id = $1`,
      [existing.id, JSON.stringify(merged), input.adAgreed ?? null, status, input.subscribedAt ?? null]
    );
    if (groupIds.length) await addToGroups(existing.id, groupIds);
    return { id: existing.id, email, result: 'updated' };
  }

  const created = await one<{ id: string }>(
    `insert into subscribers (list_id, email, status, ad_agreed, fields, source, subscribed_at,
                              unsubscribed_at)
     values ($1, $2, $3, coalesce($4,false), $5::jsonb, $6, coalesce($7::timestamptz, now()),
             case when $3 = 'unsubscribed' then coalesce($7::timestamptz, now()) end)
     returning id`,
    [
      listId,
      email,
      input.status ?? (input.pending ? 'pending' : 'subscribed'),
      input.adAgreed ?? null,
      JSON.stringify(incoming),
      input.source ?? 'api',
      input.subscribedAt ?? null,
    ]
  );
  if (groupIds.length) await addToGroups(created!.id, groupIds);
  return { id: created!.id, email, result: 'created' };
}

function pruneEmpty(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** 이름으로 그룹을 찾고 없으면 만든다. 이관 CSV 의 "그룹" 열을 그대로 살리기 위한 것. */
const groupCache = new Map<string, string>();

export async function ensureGroups(listId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const cacheKey = `${listId}:${name}`;
    const cached = groupCache.get(cacheKey);
    if (cached) {
      ids.push(cached);
      continue;
    }
    const row = await one<{ id: string }>(
      `insert into groups (list_id, name) values ($1, $2)
       on conflict (list_id, name) do update set name = excluded.name
       returning id`,
      [listId, name]
    );
    if (row) {
      groupCache.set(cacheKey, row.id);
      ids.push(row.id);
    }
  }
  return ids;
}

export async function addToGroups(subscriberId: string, groupIds: string[]) {
  for (const gid of groupIds) {
    await query(
      'insert into subscriber_groups (subscriber_id, group_id) values ($1,$2) on conflict do nothing',
      [subscriberId, gid]
    );
  }
}

export async function setGroups(subscriberId: string, groupIds: string[]) {
  await query('delete from subscriber_groups where subscriber_id = $1', [subscriberId]);
  await addToGroups(subscriberId, groupIds);
}

export async function setStatus(listId: string, emails: string[], status: string) {
  if (!['subscribed', 'unsubscribed', 'deleted'].includes(status)) throw badRequest('알 수 없는 상태입니다.');
  const res = await query(
    `update subscribers
        set status = $3,
            unsubscribed_at = case when $3 = 'unsubscribed' then now() else unsubscribed_at end,
            subscribed_at   = case when $3 = 'subscribed' then now() else subscribed_at end,
            updated_at = now()
      where list_id = $1 and lower(email) = any($2::text[])`,
    [listId, emails.map(normalizeEmail), status]
  );
  return res.rowCount ?? 0;
}

export async function subscriberGroups(subscriberId: string) {
  return many(
    `select g.id, g.name from subscriber_groups sg join groups g on g.id = sg.group_id
      where sg.subscriber_id = $1 order by g.name`,
    [subscriberId]
  );
}
