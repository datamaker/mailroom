import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';
import { requireWrite } from '../auth/plugin.js';
import { countAudience } from '../send/audience.js';

/** 새 주소록에 기본으로 깔리는 필드 — 스티비의 기본 구성과 같다. */
const DEFAULT_FIELDS = [
  { key: 'email', label: '이메일 주소', type: 'text', required: true, is_system: true, position: 0 },
  { key: 'name', label: '이름', type: 'text', required: false, is_system: true, position: 1 },
];

export async function listRoutes(app: FastifyInstance) {
  app.get('/api/lists', async () => {
    const rows = await many(
      `select l.*,
              (select count(*) from subscribers s where s.list_id = l.id and s.status = 'subscribed')::int as subscriber_count,
              (select count(*) from subscribers s where s.list_id = l.id and s.status = 'unsubscribed')::int as unsubscribed_count,
              (select max(created_at) from subscribers s where s.list_id = l.id) as last_subscriber_at
         from lists l
        order by l.created_at desc`
    );
    return { lists: rows };
  });

  app.get('/api/lists/:id', async (req) => {
    const { id } = req.params as { id: string };
    const list = await one(`select * from lists where id = $1`, [id]);
    if (!list) throw notFound('주소록을 찾을 수 없습니다.');
    const stats = await one(
      `select
         count(*) filter (where status = 'subscribed')::int   as subscribed,
         count(*) filter (where status = 'unsubscribed')::int as unsubscribed,
         count(*) filter (where status = 'deleted')::int      as deleted,
         count(*) filter (where status = 'pending')::int      as pending
       from subscribers where list_id = $1`,
      [id]
    );
    return { list, stats };
  });

  app.post('/api/lists', async (req) => {
    requireWrite(req);
    const b = req.body as Record<string, any>;
    if (!b?.name) throw badRequest('주소록 이름이 필요합니다.');

    const list = await one<{ id: string }>(
      `insert into lists (name, slug, default_sender_name, default_sender_email, sender_emails,
                          footer_company, footer_address, footer_phone, double_optin, form_language)
       values ($1, $2, $3, $4, coalesce($5::text[], '{}'), $6, $7, $8, coalesce($9::boolean, true), coalesce($10::text, 'ko'))
       returning *`,
      [
        b.name,
        b.slug ? slugify(b.slug) : slugify(b.name),
        b.default_sender_name ?? null,
        b.default_sender_email ?? null,
        b.sender_emails ?? null,
        b.footer_company ?? null,
        b.footer_address ?? null,
        b.footer_phone ?? null,
        b.double_optin,
        b.form_language,
      ]
    );

    for (const f of DEFAULT_FIELDS) {
      await query(
        `insert into custom_fields (list_id, key, label, type, required, is_system, position)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
        [list!.id, f.key, f.label, f.type, f.required, f.is_system, f.position]
      );
    }
    return { list };
  });

  const UPDATABLE = [
    'name',
    'default_sender_name',
    'default_sender_email',
    'sender_emails',
    'footer_company',
    'footer_address',
    'footer_phone',
    'auto_delete_hard_bounce',
    'allow_unsubscribed_send',
    'form_enabled',
    'form_language',
    'double_optin',
    'form_title',
    'form_description',
  ];

  app.patch('/api/lists/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of UPDATABLE) {
      if (b[key] === undefined) continue;
      params.push(b[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('변경할 항목이 없습니다.');
    const list = await one(
      `update lists set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`,
      params
    );
    if (!list) throw notFound('주소록을 찾을 수 없습니다.');
    return { list };
  });

  app.delete('/api/lists/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const used = await one<{ count: number }>(
      `select count(*)::int as count from campaigns where list_id = $1 and status in ('sending','scheduled')`,
      [id]
    );
    if (used?.count) throw badRequest('발송 중이거나 예약된 이메일이 있어 삭제할 수 없습니다.');
    await query('delete from lists where id = $1', [id]);
    return { ok: true };
  });

  // ---- 사용자 정의 필드 ----

  app.get('/api/lists/:id/fields', async (req) => {
    const { id } = req.params as { id: string };
    return { fields: await many('select * from custom_fields where list_id = $1 order by position, created_at', [id]) };
  });

  app.post('/api/lists/:id/fields', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    if (!b?.key || !b?.label) throw badRequest('key와 label이 필요합니다.');
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(b.key)) throw badRequest('key는 영문/숫자/밑줄만 쓸 수 있습니다.');
    const field = await one(
      `insert into custom_fields (list_id, key, label, type, options, default_value, required, show_on_form, position)
       values ($1,$2,$3,coalesce($4,'text'),$5,$6,coalesce($7,false),coalesce($8,true),
               coalesce($9, (select coalesce(max(position),0)+1 from custom_fields where list_id = $1)))
       returning *`,
      [id, b.key, b.label, b.type, b.options ?? null, b.default_value ?? null, b.required, b.show_on_form, b.position]
    );
    return { field };
  });

  app.patch('/api/lists/:id/fields/:fieldId', async (req) => {
    requireWrite(req);
    const { fieldId } = req.params as { fieldId: string };
    const b = req.body as Record<string, any>;
    const cols = ['label', 'type', 'options', 'default_value', 'required', 'show_on_form', 'position'];
    const sets: string[] = [];
    const params: unknown[] = [fieldId];
    for (const key of cols) {
      if (b[key] === undefined) continue;
      params.push(b[key]);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('변경할 항목이 없습니다.');
    const field = await one(`update custom_fields set ${sets.join(', ')} where id = $1 returning *`, params);
    if (!field) throw notFound('필드를 찾을 수 없습니다.');
    return { field };
  });

  app.delete('/api/lists/:id/fields/:fieldId', async (req) => {
    requireWrite(req);
    const { fieldId } = req.params as { fieldId: string };
    const f = await one<{ is_system: boolean }>('select is_system from custom_fields where id = $1', [fieldId]);
    if (!f) throw notFound('필드를 찾을 수 없습니다.');
    if (f.is_system) throw badRequest('기본 필드는 삭제할 수 없습니다.');
    await query('delete from custom_fields where id = $1', [fieldId]);
    return { ok: true };
  });

  // ---- 그룹 ----

  app.get('/api/lists/:id/groups', async (req) => {
    const { id } = req.params as { id: string };
    return {
      groups: await many(
        `select g.*, (select count(*) from subscriber_groups sg
                       join subscribers s on s.id = sg.subscriber_id and s.status = 'subscribed'
                      where sg.group_id = g.id)::int as subscriber_count
           from groups g where g.list_id = $1 order by g.name`,
        [id]
      ),
    };
  });

  app.post('/api/lists/:id/groups', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    if (!b?.name) throw badRequest('그룹 이름이 필요합니다.');
    const group = await one(
      `insert into groups (list_id, name, description) values ($1,$2,$3)
       on conflict (list_id, name) do update set description = excluded.description
       returning *`,
      [id, b.name, b.description ?? null]
    );
    return { group };
  });

  app.delete('/api/lists/:id/groups/:groupId', async (req) => {
    requireWrite(req);
    const { groupId } = req.params as { groupId: string };
    await query('delete from groups where id = $1', [groupId]);
    return { ok: true };
  });

  // ---- 세그먼트 ----

  app.get('/api/lists/:id/segments', async (req) => {
    const { id } = req.params as { id: string };
    const segments = await many<{ id: string; match: string; conditions: any[] }>(
      'select * from segments where list_id = $1 order by created_at desc',
      [id]
    );
    // 각 세그먼트가 몇 명을 잡는지 목록에서 바로 보여준다.
    const withCounts = [];
    for (const seg of segments) {
      const count = await countAudience(id, { segmentIds: [seg.id] });
      withCounts.push({ ...seg, subscriber_count: count });
    }
    return { segments: withCounts };
  });

  app.post('/api/lists/:id/segments', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    if (!b?.name) throw badRequest('세그먼트 이름이 필요합니다.');
    const segment = await one(
      `insert into segments (list_id, name, match, conditions)
       values ($1,$2,coalesce($3,'all'),coalesce($4,'[]'::jsonb)) returning *`,
      [id, b.name, b.match, JSON.stringify(b.conditions ?? [])]
    );
    return { segment };
  });

  app.patch('/api/lists/:id/segments/:segmentId', async (req) => {
    requireWrite(req);
    const { segmentId } = req.params as { segmentId: string };
    const b = req.body as Record<string, any>;
    const segment = await one(
      `update segments
          set name = coalesce($2, name),
              match = coalesce($3, match),
              conditions = coalesce($4::jsonb, conditions),
              updated_at = now()
        where id = $1 returning *`,
      [segmentId, b.name ?? null, b.match ?? null, b.conditions ? JSON.stringify(b.conditions) : null]
    );
    if (!segment) throw notFound('세그먼트를 찾을 수 없습니다.');
    return { segment };
  });

  app.delete('/api/lists/:id/segments/:segmentId', async (req) => {
    requireWrite(req);
    const { segmentId } = req.params as { segmentId: string };
    await query('delete from segments where id = $1', [segmentId]);
    return { ok: true };
  });

  /** 조건을 저장하기 전에 몇 명이 잡히는지 미리 본다. */
  app.post('/api/lists/:id/audience/count', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, any>;
    const count = await countAudience(id, {
      groupIds: b.groupIds,
      segmentIds: b.segmentIds,
      includeUnsubscribed: b.includeUnsubscribed,
      adAgreedOnly: b.adAgreedOnly,
    });
    return { count };
  });
}
