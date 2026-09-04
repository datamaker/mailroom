import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { currentUserId, requireWrite } from '../auth/plugin.js';
import { shortId } from '../lib/slug.js';
import { countAudience } from '../send/audience.js';
import { getCampaign, prefixAdSubject, renderCampaign, sendTestEmail } from '../send/campaign.js';
import { sendLocked } from '../send/provider.js';
import { config } from '../config.js';
import { renderEmailHtml } from '../render/html.js';
import { usedTags } from '../render/merge.js';
import { enqueue } from '../jobs/worker.js';
import { TRIGGER_LABELS, scanAutomation, validateTrigger, type Trigger } from '../send/automation.js';

const UPDATABLE = [
  'list_id',
  'type',
  'trigger',
  'name',
  'subject',
  'preheader',
  'sender_name',
  'sender_email',
  'reply_to',
  'content',
  'styles',
  'target',
  'tags',
  'is_ad',
  'track_opens',
  'track_clicks',
  'public_visibility',
];

const JSON_COLUMNS = new Set(['content', 'styles', 'target', 'trigger']);

export async function campaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns', async (req) => {
    const q = req.query as Record<string, string>;
    const params: unknown[] = [];
    const clauses: string[] = ['true'];

    if (q.status && q.status !== 'all') {
      params.push(q.status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (q.listId) {
      params.push(q.listId);
      clauses.push(`c.list_id = $${params.length}::uuid`);
    }
    if (q.tag) {
      params.push(q.tag);
      clauses.push(`$${params.length} = any(c.tags)`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      clauses.push(`(c.subject ilike $${params.length} or c.name ilike $${params.length})`);
    }
    if (q.from) {
      params.push(q.from);
      clauses.push(`c.created_at >= $${params.length}::timestamptz`);
    }
    if (q.to) {
      params.push(q.to);
      clauses.push(`c.created_at <= $${params.length}::timestamptz`);
    }

    const limit = Math.min(Number(q.limit) || 30, 200);
    const offset = Number(q.offset) || 0;
    const where = clauses.join(' and ');

    const total = await one<{ count: number }>(`select count(*)::int as count from campaigns c where ${where}`, params);
    const rows = await many(
      `select c.id, c.name, c.subject, c.status, c.type, c.tags, c.is_ad, c.list_id,
              c.scheduled_at, c.send_started_at, c.send_finished_at, c.created_at, c.updated_at,
              c.total_count, c.sent_count, c.failed_count, c.unique_open_count, c.unique_click_count,
              c.unsub_count, c.public_slug, c.public_visibility,
              l.name as list_name
         from campaigns c left join lists l on l.id = c.list_id
        where ${where}
        order by ${q.sort === 'sent' ? 'c.send_finished_at desc nulls last' : 'c.updated_at desc'}
        limit ${limit} offset ${offset}`,
      params
    );
    return { campaigns: rows, total: total?.count ?? 0, limit, offset };
  });

  app.get('/api/campaigns/:id', async (req) => {
    const { id } = req.params as { id: string };
    const campaign = await one(
      `select c.*, l.name as list_name from campaigns c left join lists l on l.id = c.list_id where c.id = $1`,
      [id]
    );
    if (!campaign) throw notFound('이메일을 찾을 수 없습니다.');
    return { campaign };
  });

  app.post('/api/campaigns', async (req) => {
    requireWrite(req);
    const b = (req.body ?? {}) as Record<string, any>;
    const list = b.list_id
      ? await one<{ default_sender_name: string; default_sender_email: string }>(
          'select default_sender_name, default_sender_email from lists where id = $1',
          [b.list_id]
        )
      : null;

    const campaign = await one(
      `insert into campaigns (list_id, name, subject, sender_name, sender_email, reply_to,
                              content, styles, target, tags, is_ad, public_slug, created_by)
       values ($1,$2,coalesce($3,''),$4,$5,$6,
               coalesce($7::jsonb,'[]'::jsonb), coalesce($8::jsonb,'{}'::jsonb),
               coalesce($9::jsonb,'{}'::jsonb), coalesce($10::text[],'{}'), coalesce($11::boolean,false), $12, $13)
       returning *`,
      [
        b.list_id ?? null,
        b.name ?? null,
        b.subject,
        b.sender_name ?? list?.default_sender_name ?? null,
        b.sender_email ?? list?.default_sender_email ?? null,
        b.reply_to ?? null,
        b.content ? JSON.stringify(b.content) : null,
        b.styles ? JSON.stringify(b.styles) : null,
        b.target ? JSON.stringify(b.target) : null,
        b.tags ?? null,
        b.is_ad,
        shortId(8),
        currentUserId(req),
      ]
    );
    return { campaign };
  });

  app.patch('/api/campaigns/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;

    const current = await one<{ status: string }>('select status from campaigns where id = $1', [id]);
    if (!current) throw notFound('이메일을 찾을 수 없습니다.');
    if (['sending', 'sent'].includes(current.status)) {
      throw badRequest('이미 발송되었거나 발송 중인 이메일은 수정할 수 없습니다.');
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of UPDATABLE) {
      if (b[key] === undefined) continue;
      params.push(JSON_COLUMNS.has(key) ? JSON.stringify(b[key]) : b[key]);
      sets.push(`${key} = $${params.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`);
    }
    if (!sets.length) throw badRequest('변경할 항목이 없습니다.');
    const campaign = await one(
      `update campaigns set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`,
      params
    );
    return { campaign };
  });

  /** 템플릿 내용을 이메일에 적용 */
  app.post('/api/campaigns/:id/apply-template', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { templateId?: string };
    if (!b.templateId) throw badRequest('templateId가 필요합니다.');
    const t = await one<any>('select content, styles from templates where id = $1', [b.templateId]);
    if (!t) throw notFound('템플릿을 찾을 수 없습니다.');
    const campaign = await one(
      `update campaigns set content = $2::jsonb, styles = $3::jsonb, updated_at = now()
        where id = $1 and status in ('draft','paused') returning *`,
      [id, JSON.stringify(t.content), JSON.stringify(t.styles ?? {})]
    );
    if (!campaign) throw badRequest('작성 중인 이메일에만 적용할 수 있습니다.');
    return { campaign };
  });

  app.post('/api/campaigns/:id/duplicate', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const c = await getCampaign(id);
    const copy = await one(
      `insert into campaigns (list_id, name, subject, preheader, sender_name, sender_email, reply_to,
                              content, styles, target, tags, is_ad, track_opens, track_clicks,
                              public_slug, created_by)
       select list_id, name, subject, preheader, sender_name, sender_email, reply_to,
              content, styles, target, tags, is_ad, track_opens, track_clicks, $2, $3
         from campaigns where id = $1
       returning *`,
      [c.id, shortId(8), currentUserId(req)]
    );
    return { campaign: copy };
  });

  app.delete('/api/campaigns/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const c = await one<{ status: string }>('select status from campaigns where id = $1', [id]);
    if (c?.status === 'sending') throw badRequest('발송 중인 이메일은 삭제할 수 없습니다.');
    await query('delete from campaigns where id = $1', [id]);
    return { ok: true };
  });

  /** 에디터 미리보기 / HTML 내보내기 */
  app.get('/api/campaigns/:id/html', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const c = await getCampaign(id);
    const html = await renderCampaign(c, {
      mode: q.mode === 'web' ? 'web' : 'email',
      sample: q.sample === '1' ? { name: '홍길동', email: 'sample@example.com' } : undefined,
    });
    return { html, subject: prefixAdSubject(c.subject, c.is_ad) };
  });

  /** 저장 전 블록 배열을 그대로 렌더 — 에디터 실시간 미리보기용 */
  app.post('/api/render/preview', async (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const html = renderEmailHtml(b.content ?? [], {
      styles: b.styles,
      footer: b.footer,
      webviewUrl: '#',
      unsubscribeUrl: '#',
      preferencesUrl: '#',
    });
    return { html, tags: usedTags(JSON.stringify(b.content ?? [])) };
  });

  app.post('/api/campaigns/:id/test', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as { recipients?: string[] };
    if (!b?.recipients?.length) throw badRequest('테스트 수신자가 필요합니다.');
    const results = await sendTestEmail(id, b.recipients);
    return { results };
  });

  /** 발송 대상 규모와 사전 점검 결과 */
  app.get('/api/campaigns/:id/audience', async (req) => {
    const { id } = req.params as { id: string };
    const c = await getCampaign(id);
    if (!c.list_id) return { count: 0, issues: ['주소록이 선택되지 않았습니다.'] };
    const count = await countAudience(c.list_id, c.target || {});

    const issues: string[] = [];
    if (sendLocked()) {
      issues.push(
        `발송 잠금이 켜져 있습니다 — 실제 발송이 막혀 있습니다` +
          (config.send.allowedRecipients.length
            ? ` (허용: ${config.send.allowedRecipients.join(', ')})`
            : '')
      );
    }
    if (!c.subject.trim()) issues.push('제목이 비어 있습니다.');
    if (!c.sender_email) issues.push('발신자 이메일 주소가 없습니다.');
    if (!Array.isArray(c.content) || !c.content.length) issues.push('콘텐츠가 비어 있습니다.');
    if (count === 0) issues.push('발송 대상이 0명입니다.');

    const sender = c.sender_email
      ? await one<{ verified: boolean }>('select verified from senders where lower(email) = lower($1)', [c.sender_email])
      : null;
    if (c.sender_email && !sender?.verified) issues.push(`발신자 ${c.sender_email} 이(가) 인증되지 않았습니다.`);

    // 푸터 상자가 없어도 텍스트 안에 $%unsubscribe%$ 가 있으면 된다.
    // (가져온 콘텐츠는 푸터를 텍스트 상자로 갖고 있는 경우가 많다)
    const serialized = JSON.stringify(c.content ?? []);
    const hasUnsubscribe =
      serialized.includes('unsubscribe') || serialized.includes('"footer"');
    if (!hasUnsubscribe) {
      issues.push('수신거부 링크가 없습니다 — 푸터 상자를 넣거나 본문에 $%unsubscribe%$ 를 쓰세요.');
    }
    if (c.is_ad && !/^\(광고/.test(c.subject.trim())) issues.push('광고 메일이면 제목에 (광고)가 자동으로 붙습니다.');

    return { count, issues };
  });

  app.post('/api/campaigns/:id/schedule', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as { scheduled_at?: string };
    if (!b?.scheduled_at) throw badRequest('scheduled_at이 필요합니다.');
    const when = new Date(b.scheduled_at);
    if (Number.isNaN(when.getTime())) throw badRequest('scheduled_at 형식이 올바르지 않습니다.');
    if (when.getTime() < Date.now() - 60_000) throw badRequest('과거 시각으로는 예약할 수 없습니다.');

    await assertSendable(id);
    const campaign = await one(
      `update campaigns set status = 'scheduled', scheduled_at = $2, updated_at = now()
        where id = $1 and status in ('draft','scheduled') returning *`,
      [id, when]
    );
    if (!campaign) throw badRequest('예약할 수 없는 상태입니다.');
    return { campaign };
  });

  app.post('/api/campaigns/:id/send', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    await assertSendable(id);
    const campaign = await one(
      `update campaigns set status = 'sending', scheduled_at = null, updated_at = now()
        where id = $1 and status in ('draft','scheduled','paused') returning *`,
      [id]
    );
    if (!campaign) throw badRequest('발송할 수 없는 상태입니다.');
    await enqueue('send_campaign', id);
    return { campaign };
  });

  app.post('/api/campaigns/:id/pause', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const campaign = await one(
      `update campaigns set status = 'paused', updated_at = now()
        where id = $1 and status in ('sending','scheduled') returning *`,
      [id]
    );
    if (!campaign) throw badRequest('일시중지할 수 없는 상태입니다.');
    return { campaign };
  });

  app.post('/api/campaigns/:id/resume', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const campaign = await one(
      `update campaigns set status = 'sending', updated_at = now() where id = $1 and status = 'paused' returning *`,
      [id]
    );
    if (!campaign) throw badRequest('재개할 수 없는 상태입니다.');
    await enqueue('send_batch', id);
    return { campaign };
  });

  app.post('/api/campaigns/:id/cancel', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const campaign = await one(
      `update campaigns set status = 'canceled', updated_at = now()
        where id = $1 and status in ('scheduled','paused') returning *`,
      [id]
    );
    if (!campaign) throw badRequest('취소할 수 없는 상태입니다. 발송 중이면 먼저 일시중지하세요.');
    return { campaign };
  });
  // ---- 자동 이메일 ----

  app.get('/api/automations/triggers', async () => ({
    triggers: Object.entries(TRIGGER_LABELS).map(([type, label]) => ({ type, label })),
  }));

  app.post('/api/campaigns/:id/activate', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const c = await getCampaign(id);
    if (!c.list_id) throw badRequest('주소록이 선택되지 않았습니다.');
    if (!c.sender_email) throw badRequest('발신자 이메일 주소가 없습니다.');
    if (!c.subject.trim()) throw badRequest('제목이 비어 있습니다.');
    if (!Array.isArray(c.content) || !c.content.length) throw badRequest('콘텐츠가 비어 있습니다.');
    validateTrigger((c as any).trigger as Trigger);
    if (sendLocked()) throw badRequest('발송이 잠겨 있어 자동 이메일을 켤 수 없습니다.');

    // activated_at 을 여기서 찍는다 — 이 시각 이후의 사건만 발동 대상이라,
    // 켜자마자 기존 구독자 전원에게 나가는 사고를 구조적으로 막는다.
    const campaign = await one<any>(
      `update campaigns
          set type = 'automation', status = 'active',
              activated_at = coalesce(activated_at, now()), updated_at = now()
        where id = $1 and status in ('draft','paused','active') returning *`,
      [id]
    );
    if (!campaign) throw badRequest('활성화할 수 없는 상태입니다.');
    const scheduled = await scanAutomation(campaign);
    return { campaign, scheduled };
  });

  app.post('/api/campaigns/:id/deactivate', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const campaign = await one(
      `update campaigns set status = 'paused', updated_at = now()
        where id = $1 and type = 'automation' returning *`,
      [id]
    );
    if (!campaign) throw badRequest('자동 이메일이 아닙니다.');
    return { campaign };
  });

  /** 자동 이메일 실행 현황 */
  app.get('/api/campaigns/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const summary = await one(
      `select count(*) filter (where status = 'scheduled')::int as scheduled,
              count(*) filter (where status = 'sent')::int      as sent,
              count(*) filter (where status = 'skipped')::int   as skipped,
              count(*) filter (where status = 'failed')::int    as failed
         from automation_runs where campaign_id = $1`,
      [id]
    );
    const runs = await many(
      `select r.id, r.status, r.scheduled_at, r.sent_at, r.error, s.email
         from automation_runs r left join subscribers s on s.id = r.subscriber_id
        where r.campaign_id = $1
        order by coalesce(r.sent_at, r.scheduled_at) desc
        limit ${Math.min(Number(q.limit) || 50, 500)}`,
      [id]
    );
    return { summary, runs };
  });
}

async function assertSendable(id: string) {
  if (sendLocked()) {
    throw badRequest(
      '발송이 잠겨 있습니다. 서버의 MAILROOM_SEND_LOCK 을 끄기 전에는 구독자에게 보낼 수 없습니다.'
    );
  }
  const c = await getCampaign(id);
  if (!c.list_id) throw badRequest('주소록이 선택되지 않았습니다.');
  if (!c.sender_email) throw badRequest('발신자 이메일 주소가 없습니다.');
  if (!c.subject.trim()) throw badRequest('제목이 비어 있습니다.');
  if (!Array.isArray(c.content) || !c.content.length) throw badRequest('콘텐츠가 비어 있습니다.');
  const count = await countAudience(c.list_id, c.target || {});
  if (count === 0) throw badRequest('발송 대상이 0명입니다.');
}
