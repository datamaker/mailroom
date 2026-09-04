import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireWrite } from '../auth/plugin.js';
import { buildSegmentWhere } from '../send/audience.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import {
  normalizeEmail,
  setGroups,
  setStatus,
  subscriberGroups,
  upsertSubscriber,
} from '../lib/subscribers.js';

export async function subscriberRoutes(app: FastifyInstance) {
  app.get('/api/lists/:id/subscribers', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;

    const params: unknown[] = [id];
    const clauses = ['s.list_id = $1'];

    if (q.status && q.status !== 'all') {
      params.push(q.status);
      clauses.push(`s.status = $${params.length}`);
    } else if (!q.status) {
      clauses.push(`s.status = 'subscribed'`);
    }

    if (q.q) {
      params.push(`%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      const p = `$${params.length}`;
      // 이메일과 모든 사용자 정의 필드 값을 한 번에 훑는다.
      clauses.push(`(s.email ilike ${p} or exists (
        select 1 from jsonb_each_text(s.fields) f where f.value ilike ${p}
      ))`);
    }

    if (q.groupId) {
      params.push(q.groupId);
      clauses.push(
        `exists (select 1 from subscriber_groups sg where sg.subscriber_id = s.id and sg.group_id = $${params.length}::uuid)`
      );
    }

    if (q.segmentId) {
      const seg = await one<{ match: string; conditions: any[] }>(
        'select match, conditions from segments where id = $1 and list_id = $2',
        [q.segmentId, id]
      );
      if (seg) {
        const built = buildSegmentWhere({ match: seg.match as any, conditions: seg.conditions }, params);
        params.length = 0;
        params.push(...built.params);
        clauses.push(`(${built.where})`);
      }
    }

    if (q.filter) {
      let parsed: any;
      try {
        parsed = JSON.parse(q.filter);
      } catch {
        throw badRequest('filter 파라미터가 올바른 JSON이 아닙니다.');
      }
      const built = buildSegmentWhere({ match: parsed.match, conditions: parsed.conditions }, params);
      params.length = 0;
      params.push(...built.params);
      clauses.push(`(${built.where})`);
    }

    const where = clauses.join(' and ');
    const limit = Math.min(Number(q.limit) || 50, 1000);
    const offset = Number(q.offset) || 0;

    const total = await one<{ count: number }>(
      `select count(*)::int as count from subscribers s where ${where}`,
      params
    );

    const sortable: Record<string, string> = {
      email: 's.email',
      created_at: 's.created_at',
      subscribed_at: 's.subscribed_at',
      updated_at: 's.updated_at',
    };
    const sort = sortable[q.sort ?? 'created_at'] ?? 's.created_at';
    const dir = q.dir === 'asc' ? 'asc' : 'desc';

    const rows = await many(
      `select s.*,
              coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name) order by g.name)
                          from subscriber_groups sg join groups g on g.id = sg.group_id
                         where sg.subscriber_id = s.id), '[]'::json) as groups
         from subscribers s
        where ${where}
        order by ${sort} ${dir}
        limit ${limit} offset ${offset}`,
      params
    );

    return { subscribers: rows, total: total?.count ?? 0, limit, offset };
  });

  app.get('/api/lists/:id/subscribers/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const status = q.status && q.status !== 'all' ? q.status : null;

    const fields = await many<{ key: string; label: string }>(
      'select key, label from custom_fields where list_id = $1 order by position',
      [id]
    );
    const rows = await many<any>(
      `select s.*, coalesce((select string_agg(g.name, '|' order by g.name)
                               from subscriber_groups sg join groups g on g.id = sg.group_id
                              where sg.subscriber_id = s.id), '') as group_names
         from subscribers s
        where s.list_id = $1 ${status ? 'and s.status = $2' : ''}
        order by s.created_at desc`,
      status ? [id, status] : [id]
    );

    const out = rows.map((r) => {
      const rec: Record<string, unknown> = { 이메일: r.email, 상태: r.status };
      for (const f of fields) if (f.key !== 'email') rec[f.label] = r.fields?.[f.key] ?? '';
      rec['광고성 정보 수신 동의'] = r.ad_agreed ? 'Y' : 'N';
      rec['그룹'] = r.group_names;
      rec['구독일'] = r.subscribed_at;
      rec['마지막 업데이트일'] = r.updated_at;
      return rec;
    });

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="subscribers-${id}.csv"`);
    return toCsv(out);
  });

  app.get('/api/lists/:id/subscribers/:subId', async (req) => {
    const { subId } = req.params as { subId: string };
    const sub = await one('select * from subscribers where id = $1', [subId]);
    if (!sub) throw notFound('구독자를 찾을 수 없습니다.');
    const groups = await subscriberGroups(subId);
    const activity = await many(
      `select e.type, e.url, e.created_at, c.subject
         from events e left join campaigns c on c.id = e.campaign_id
        where e.subscriber_id = $1
        order by e.created_at desc limit 50`,
      [subId]
    );
    return { subscriber: sub, groups, activity };
  });

  /** 단건/다건 추가. 스티비의 "직접 추가하기" + API 추가가 같은 경로를 쓴다. */
  app.post('/api/lists/:id/subscribers', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    const input = Array.isArray(b) ? b : b.subscribers ? b.subscribers : [b];
    const results = [];
    for (const s of input) {
      results.push(
        await upsertSubscriber(id, {
          email: s.email,
          fields: s.fields ?? stripReserved(s),
          adAgreed: s.ad_agreed ?? s.adAgreed,
          groupIds: b.groupIds ?? s.groupIds,
          source: b.source ?? 'manual',
          by: b.by ?? 'MANUAL',
          clearEmpty: b.clearEmpty ?? false,
        })
      );
    }
    return summarize(results);
  });

  app.patch('/api/lists/:id/subscribers/:subId', async (req) => {
    requireWrite(req);
    const { subId } = req.params as { subId: string };
    const b = req.body as Record<string, any>;
    const sub = await one<{ fields: Record<string, unknown> }>('select fields from subscribers where id = $1', [subId]);
    if (!sub) throw notFound('구독자를 찾을 수 없습니다.');

    const fields = b.fields ? { ...sub.fields, ...b.fields } : sub.fields;
    const updated = await one(
      `update subscribers
          set fields = $2::jsonb,
              ad_agreed = coalesce($3, ad_agreed),
              status = coalesce($4, status),
              updated_at = now()
        where id = $1 returning *`,
      [subId, JSON.stringify(fields), b.ad_agreed ?? null, b.status ?? null]
    );
    if (b.groupIds) await setGroups(subId, b.groupIds);
    return { subscriber: updated };
  });

  app.post('/api/lists/:id/subscribers/status', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as { emails?: string[]; status: string };
    if (!b?.emails?.length) throw badRequest('emails가 필요합니다.');
    const changed = await setStatus(id, b.emails, b.status);
    return { changed };
  });

  app.delete('/api/lists/:id/subscribers', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as { emails?: string[] };
    if (!b?.emails?.length) throw badRequest('emails가 필요합니다.');
    const res = await query('delete from subscribers where list_id = $1 and lower(email) = any($2::text[])', [
      id,
      b.emails.map(normalizeEmail),
    ]);
    return { deleted: res.rowCount ?? 0 };
  });

  /** CSV 업로드. 헤더는 필드 label 또는 key 어느 쪽이든 받는다. */
  app.post('/api/lists/:id/subscribers/import', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as { csv?: string; groupIds?: string[]; clearEmpty?: boolean; mapping?: Record<string, string> };
    if (!b?.csv) throw badRequest('csv 본문이 필요합니다.');

    const fields = await many<{ key: string; label: string }>(
      'select key, label from custom_fields where list_id = $1',
      [id]
    );
    const byLabel = new Map(fields.map((f) => [f.label.trim(), f.key]));
    const byKey = new Map(fields.map((f) => [f.key, f.key]));

    const rows = parseCsv(b.csv);
    const results = [];
    for (const row of rows) {
      const mapped: Record<string, unknown> = {};
      let email = '';
      let adAgreed: boolean | undefined;

      for (const [header, value] of Object.entries(row)) {
        const key = b.mapping?.[header] ?? byKey.get(header) ?? byLabel.get(header.trim());
        if (!key) {
          if (['이메일', '이메일 주소', 'email'].includes(header.trim().toLowerCase())) email = value;
          if (['광고성 정보 수신 동의', 'ad_agreed'].includes(header.trim())) adAgreed = /^(y|yes|true|1)$/i.test(value);
          continue;
        }
        if (key === 'email') email = value;
        else mapped[key] = value;
      }

      results.push(
        await upsertSubscriber(id, {
          email,
          fields: mapped,
          adAgreed,
          groupIds: b.groupIds,
          source: 'import',
          by: 'MANUAL',
          clearEmpty: b.clearEmpty ?? false,
        })
      );
    }
    return summarize(results);
  });
}

function stripReserved(s: Record<string, any>) {
  const { email, ad_agreed, adAgreed, groupIds, status, ...rest } = s;
  return rest;
}

function summarize(results: Array<{ result: string; email: string; reason?: string }>) {
  return {
    created: results.filter((r) => r.result === 'created').length,
    updated: results.filter((r) => r.result === 'updated').length,
    skipped: results.filter((r) => r.result === 'skipped').length,
    errors: results.filter((r) => r.result === 'skipped').map((r) => ({ email: r.email, reason: r.reason })),
    results,
  };
}
