import type { FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';

/**
 * 감사 기록. 구독자 명단을 내보내거나 대량으로 읽은 사람(또는 API 키)을 남긴다.
 * 명단이 밖에서 발견됐을 때 "누가, 언제, 얼마나 가져갔나"에 답할 수 있어야 한다.
 */
export type AuditAction =
  | 'subscribers.export'
  | 'subscribers.bulk_read'
  | 'campaign.engagement.export'
  | 'campaign.link_clicks.export'
  | 'campaign.stats.export';

/** 한 번에 이보다 많이 읽으면 대량 조회로 본다. 관리 화면의 한 페이지가 100건이다. */
export const BULK_READ_THRESHOLD = 100;

export interface AuditEntry {
  action: AuditAction;
  listId?: string | null;
  campaignId?: string | null;
  count: number;
  detail?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/**
 * 기록에 실패하면 요청도 실패시킨다 — 흔적 없이 명단이 나가는 것보다 내보내기가 막히는 편이 낫다.
 * 응답을 보내기 전에 부른다.
 */
export async function recordAudit(req: FastifyRequest, entry: AuditEntry) {
  const actor = req.actor;
  const key = actor?.apiKeyId
    ? await one<{ name: string }>('select name from api_keys where id = $1', [actor.apiKeyId])
    : null;
  await query(
    `insert into audit_log (action, actor_user_id, actor_email, api_key_id, api_key_name,
                            list_id, campaign_id, row_count, ip, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      entry.action,
      actor?.user?.id ?? null,
      actor?.user?.email ?? null,
      actor?.apiKeyId ?? null,
      key?.name ?? null,
      uuidOrNull(entry.listId),
      uuidOrNull(entry.campaignId),
      entry.count,
      req.ip ?? null,
      JSON.stringify(entry.detail ?? {}),
    ]
  );
}
