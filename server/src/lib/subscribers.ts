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
   * 'SUBSCRIBER' — 본인이 신청했다고 **인증된 연동**(API 키)이 알려 준 경우. 수신거부였어도
   *                다시 구독 중으로 바꾼다. 로그인 없는 구독폼·공개 API 는 이 함수를 쓰지 않고
   *                publicSubscribe 를 쓴다 — 거기서는 기존 구독자를 건드리지 않는다.
   */
  by?: 'MANUAL' | 'SUBSCRIBER';
  /** 값이 빈 필드를 기존 값 삭제로 볼지 ("빈 값으로 업데이트" 옵션) */
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
    // 운영자가 넣은 건 수신거부를 되살리지 않는다.
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

/** 주소록 정의와 무관하게 구독자에게 늘 붙어 있는 필드. email 은 필드가 아니라 열이다. */
const BUILTIN_FIELD_KEYS = ['name'];
const MAX_FIELD_VALUE_LENGTH = 1000;

/** 이 주소록에서 구독자가 스스로 채울 수 있는 필드 키 — 주소록에 정의된 것과 기본 필드뿐이다. */
export async function allowedFieldKeys(listId: string): Promise<Set<string>> {
  const rows = await many<{ key: string }>('select key from custom_fields where list_id = $1', [listId]);
  const keys = new Set([...rows.map((r) => r.key), ...BUILTIN_FIELD_KEYS]);
  keys.delete('email');
  return keys;
}

/**
 * 바깥(구독폼·공개 API·구독정보 변경 페이지)에서 들어온 필드를 걸러 낸다.
 * 정의되지 않은 키는 버리고, 값은 길이를 자른 문자열·숫자·불리언만 받는다 —
 * 안 그러면 누구나 구독자 레코드에 임의의 키와 큰 값을 쌓을 수 있다.
 */
export function sanitizeFields(input: unknown, allowed: ReadonlySet<string>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string') out[key] = value.trim().slice(0, MAX_FIELD_VALUE_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** 확인 토큰에 실어 두었다가 확인되는 순간에만 반영하는 신청 내용. */
export interface PendingChanges {
  fields?: Record<string, string | number | boolean>;
  adAgreed?: boolean;
}

export interface PublicSubscribeOutcome extends UpsertOutcome {
  /**
   * 확인 메일을 보내야 하는가. true 면 호출부가 changes 를 토큰에 실어 보낸다.
   * 주소록이 더블 옵트인이 아니어도, 이미 있는 주소가 구독 중이 아니면 true 다.
   */
  needsConfirm: boolean;
  changes: PendingChanges;
}

/**
 * 로그인 없이 들어오는 구독 신청(구독폼·공개 API).
 *
 * 신청자가 그 주소의 주인인지 알 수 없다. 그래서
 *   - 이미 있는 구독자의 필드·광고 수신 동의·상태는 **여기서 절대 바꾸지 않는다.**
 *     (예전엔 남의 주소를 적어 넣으면 그 사람의 이름·회사가 덮어써지고, 수신거부한 사람이
 *      다시 구독 상태가 됐다.)
 *   - 바꿀 내용은 확인 메일의 토큰에 실어, 주인이 메일의 버튼을 눌렀을 때만 반영한다.
 *   - 새 주소는 지금처럼 넣는다. 덮어쓸 기존 정보가 없기 때문이다.
 */
export async function publicSubscribe(
  list: { id: string; double_optin: boolean },
  input: { email: string; fields?: unknown; adAgreed?: boolean }
): Promise<PublicSubscribeOutcome> {
  const email = normalizeEmail(input.email);
  const changes: PendingChanges = {};
  if (!isValidEmail(email)) {
    return { id: null, email, result: 'skipped', reason: '올바르지 않은 이메일 주소', needsConfirm: false, changes };
  }

  const fields = pruneEmpty(sanitizeFields(input.fields, await allowedFieldKeys(list.id))) as PendingChanges['fields'];
  if (fields && Object.keys(fields).length) changes.fields = fields;
  if (typeof input.adAgreed === 'boolean') changes.adAgreed = input.adAgreed;

  const existing = await one<{ id: string; status: string }>(
    'select id, status from subscribers where list_id = $1 and lower(email) = $2',
    [list.id, email]
  );

  if (existing) {
    // 구독 중이 아닌 주소(수신거부·삭제·확인 대기)는 주소록 설정과 상관없이 확인을 거친다.
    // 구독 중인 주소는 더블 옵트인 주소록에서만 확인 메일로 정보 변경을 받아 준다.
    const needsConfirm = existing.status !== 'subscribed' || list.double_optin;
    return { id: existing.id, email, result: 'updated', needsConfirm, changes };
  }

  const created = await one<{ id: string }>(
    `insert into subscribers (list_id, email, status, ad_agreed, fields, source)
     values ($1, $2, $3, $4, $5::jsonb, 'form')
     on conflict (list_id, lower(email)) do nothing
     returning id`,
    [list.id, email, list.double_optin ? 'pending' : 'subscribed', changes.adAgreed ?? false, JSON.stringify(fields ?? {})]
  );
  if (!created) {
    // 같은 주소가 동시에 들어왔다. 방금 생긴 행은 건드리지 않는다.
    const row = await one<{ id: string }>('select id from subscribers where list_id = $1 and lower(email) = $2', [list.id, email]);
    return { id: row?.id ?? null, email, result: 'updated', needsConfirm: true, changes };
  }
  // 새 행에는 이미 다 들어갔다 — 확인할 때 다시 반영할 것은 없다.
  return { id: created.id, email, result: 'created', needsConfirm: list.double_optin, changes: {} };
}

/** 토큰으로 본인임이 확인된 구독자가 자기 정보를 바꾼다. 허용된 키만, 기존 값 위에 덮는다. */
export async function applySubscriberChanges(subscriberId: string, listId: string, changes: PendingChanges) {
  const fields = sanitizeFields(changes.fields, await allowedFieldKeys(listId));
  await query(
    `update subscribers
        set fields = fields || $2::jsonb,
            ad_agreed = coalesce($3, ad_agreed),
            updated_at = now()
      where id = $1`,
    [subscriberId, JSON.stringify(fields), typeof changes.adAgreed === 'boolean' ? changes.adAgreed : null]
  );
}

function pruneEmpty(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** 이름으로 그룹을 찾고 없으면 만든다. 내보내기 CSV 의 "그룹" 열을 그대로 살리기 위한 것. */
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
