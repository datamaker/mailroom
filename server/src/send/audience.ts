import { many, one } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

/**
 * 세그먼트 조건 → SQL. 구독자 목록 필터와 세그먼트가 같은 문법을 쓴다.
 *
 *  { type:'field',        key:'company', op:'contains', value:'대학교' }
 *  { type:'status',       value:'subscribed' }
 *  { type:'ad_agreed',    value:true }
 *  { type:'group',        op:'in'|'not_in', value:['<groupId>'] }
 *  { type:'subscribed_at',op:'before'|'after'|'within_days', value:'2026-01-01'|30 }
 *  { type:'activity',     op:'opened'|'not_opened'|'clicked'|'not_clicked',
 *                         campaignId?:'<uuid>', withinDays?:90 }
 */
export type Condition = Record<string, any>;

export interface SegmentSpec {
  match?: 'all' | 'any';
  conditions?: Condition[];
}

interface Built {
  where: string;
  params: unknown[];
}

const FIELD_OPS = new Set([
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
]);

function buildCondition(c: Condition, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  switch (c.type) {
    case 'field': {
      const key = String(c.key || '');
      if (!key) throw badRequest('field 조건에 key가 없습니다.');
      const op = String(c.op || 'eq');
      if (!FIELD_OPS.has(op)) throw badRequest(`지원하지 않는 연산자: ${op}`);
      const expr = key === 'email' ? 's.email' : `(s.fields ->> ${p(key)})`;

      switch (op) {
        case 'is_empty':
          return `coalesce(${expr}, '') = ''`;
        case 'is_not_empty':
          return `coalesce(${expr}, '') <> ''`;
        case 'eq':
          return `lower(coalesce(${expr},'')) = lower(${p(String(c.value ?? ''))})`;
        case 'neq':
          return `lower(coalesce(${expr},'')) <> lower(${p(String(c.value ?? ''))})`;
        case 'contains':
          return `coalesce(${expr},'') ilike ${p(`%${escapeLike(String(c.value ?? ''))}%`)}`;
        case 'not_contains':
          return `coalesce(${expr},'') not ilike ${p(`%${escapeLike(String(c.value ?? ''))}%`)}`;
        case 'starts_with':
          return `coalesce(${expr},'') ilike ${p(`${escapeLike(String(c.value ?? ''))}%`)}`;
        case 'ends_with':
          return `coalesce(${expr},'') ilike ${p(`%${escapeLike(String(c.value ?? ''))}`)}`;
      }
      return 'true';
    }

    case 'status':
      return `s.status = ${p(String(c.value || 'subscribed'))}`;

    case 'ad_agreed':
      return `s.ad_agreed = ${p(Boolean(c.value))}`;

    case 'group': {
      const ids: string[] = Array.isArray(c.value) ? c.value : [c.value].filter(Boolean);
      if (!ids.length) return 'true';
      const inner = `exists (select 1 from subscriber_groups sg where sg.subscriber_id = s.id and sg.group_id = any(${p(
        ids
      )}::uuid[]))`;
      return c.op === 'not_in' ? `not ${inner}` : inner;
    }

    case 'subscribed_at': {
      if (c.op === 'within_days') return `s.subscribed_at >= now() - ${p(Number(c.value) || 30)} * interval '1 day'`;
      if (c.op === 'before') return `s.subscribed_at < ${p(String(c.value))}::timestamptz`;
      return `s.subscribed_at >= ${p(String(c.value))}::timestamptz`;
    }

    case 'activity': {
      const op = String(c.op || 'opened');
      const evType = op.includes('click') ? 'click' : 'open';
      const negate = op.startsWith('not_');
      const clauses = [`e.subscriber_id = s.id`, `e.type = ${p(evType)}`];
      if (c.campaignId) clauses.push(`e.campaign_id = ${p(String(c.campaignId))}::uuid`);
      if (c.withinDays) clauses.push(`e.created_at >= now() - ${p(Number(c.withinDays))} * interval '1 day'`);
      const inner = `exists (select 1 from events e where ${clauses.join(' and ')})`;
      return negate ? `not ${inner}` : inner;
    }

    default:
      throw badRequest(`알 수 없는 조건 타입: ${c.type}`);
  }
}

function escapeLike(v: string) {
  return v.replace(/[%_\\]/g, (m) => `\\${m}`);
}

export function buildSegmentWhere(spec: SegmentSpec, startParams: unknown[] = []): Built {
  const params = [...startParams];
  const conditions = spec.conditions || [];
  if (!conditions.length) return { where: 'true', params };
  const parts = conditions.map((c) => `(${buildCondition(c, params)})`);
  const glue = spec.match === 'any' ? ' or ' : ' and ';
  return { where: parts.join(glue), params };
}

export interface AudienceTarget {
  /** 지정하면 이 그룹들 중 하나라도 속한 구독자 */
  groupIds?: string[];
  /** 지정하면 이 세그먼트들 중 하나라도 통과한 구독자 */
  segmentIds?: string[];
  /** 기본은 구독 중만 */
  includeUnsubscribed?: boolean;
  /** 광고성 정보 수신 동의자만 (광고 메일) */
  adAgreedOnly?: boolean;
}

/** 캠페인 발송 대상 SQL. `s` 별칭으로 subscribers 를 참조한다. */
export async function buildAudienceQuery(listId: string, target: AudienceTarget) {
  const params: unknown[] = [listId];
  const clauses: string[] = ['s.list_id = $1'];

  clauses.push(target.includeUnsubscribed ? `s.status <> 'deleted'` : `s.status = 'subscribed'`);

  if (target.adAgreedOnly) clauses.push('s.ad_agreed = true');

  if (target.groupIds?.length) {
    params.push(target.groupIds);
    clauses.push(
      `exists (select 1 from subscriber_groups sg where sg.subscriber_id = s.id and sg.group_id = any($${params.length}::uuid[]))`
    );
  }

  if (target.segmentIds?.length) {
    const segments = await many<{ id: string; match: string; conditions: Condition[] }>(
      'select id, match, conditions from segments where list_id = $1 and id = any($2::uuid[])',
      [listId, target.segmentIds]
    );
    if (segments.length) {
      const segClauses: string[] = [];
      for (const seg of segments) {
        const built = buildSegmentWhere({ match: seg.match as 'all' | 'any', conditions: seg.conditions }, params);
        params.length = 0;
        params.push(...built.params);
        segClauses.push(`(${built.where})`);
      }
      clauses.push(`(${segClauses.join(' or ')})`);
    }
  }

  // 하드바운스/스팸신고로 전역 차단된 주소는 어떤 캠페인에도 안 나간다.
  clauses.push('not exists (select 1 from suppressions sup where lower(sup.email) = lower(s.email))');

  return { where: clauses.join(' and '), params };
}

export async function countAudience(listId: string, target: AudienceTarget) {
  const { where, params } = await buildAudienceQuery(listId, target);
  const row = await one<{ count: number }>(
    `select count(*)::int as count from subscribers s where ${where}`,
    params
  );
  return row?.count ?? 0;
}
