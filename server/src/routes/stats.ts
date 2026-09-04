import type { FastifyInstance } from 'fastify';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';

/**
 * 발송 통계. 스티비의 캠페인 대시보드 + 전체 통계 화면에 대응한다.
 * (요금제/페이지 통계는 범위 밖 — 발송 성과만 다룬다.)
 */
export async function statsRoutes(app: FastifyInstance) {
  app.get('/api/campaigns/:id/stats', async (req) => {
    const { id } = req.params as { id: string };
    const c = await one<any>('select * from campaigns where id = $1', [id]);
    if (!c) throw notFound('이메일을 찾을 수 없습니다.');

    const totals = await one<any>(
      `select
         count(*)::int                                          as total,
         count(*) filter (where status = 'sent')::int           as sent,
         count(*) filter (where status = 'failed')::int         as failed,
         count(*) filter (where status = 'bounced')::int        as bounced,
         count(*) filter (where opened_at is not null)::int     as unique_opens,
         count(*) filter (where clicked_at is not null)::int    as unique_clicks,
         coalesce(sum(open_count),0)::int                       as opens,
         coalesce(sum(click_count),0)::int                      as clicks
       from campaign_recipients where campaign_id = $1`,
      [id]
    );

    const evCounts = await one<any>(
      `select
         count(*) filter (where type = 'unsubscribe')::int as unsubscribes,
         count(*) filter (where type = 'complaint')::int   as complaints,
         count(*) filter (where type = 'bounce')::int      as bounces
       from events where campaign_id = $1`,
      [id]
    );

    // 발송 후 24시간 오픈/클릭 추이 (스티비의 시간별 라인차트)
    const timeline = await many<any>(
      `select date_trunc('hour', e.created_at) as hour,
              count(*) filter (where e.type = 'open')::int  as opens,
              count(*) filter (where e.type = 'click')::int as clicks
         from events e
        where e.campaign_id = $1 and e.type in ('open','click')
          and e.created_at < coalesce((select send_started_at from campaigns where id = $1), e.created_at) + interval '48 hours'
        group by 1 order by 1`,
      [id]
    );

    const links = await many<any>(
      `select l.id, l.url, l.click_count, l.unique_click_count
         from campaign_links l where l.campaign_id = $1
        order by l.click_count desc limit 20`,
      [id]
    );

    const topOpeners = await many<any>(
      `select r.email, r.open_count from campaign_recipients r
        where r.campaign_id = $1 and r.open_count > 0
        order by r.open_count desc limit 10`,
      [id]
    );

    const topClickers = await many<any>(
      `select r.email, r.click_count from campaign_recipients r
        where r.campaign_id = $1 and r.click_count > 0
        order by r.click_count desc limit 10`,
      [id]
    );

    const devices = await many<any>(
      `select coalesce(device,'unknown') as device, coalesce(os,'unknown') as os,
              coalesce(client,'other') as client, count(*)::int as count
         from events where campaign_id = $1 and type = 'open'
        group by 1,2,3`,
      [id]
    );

    const denom = totals.sent || 1;
    return {
      campaign: {
        id: c.id,
        subject: c.subject,
        status: c.status,
        list_id: c.list_id,
        sender_name: c.sender_name,
        sender_email: c.sender_email,
        send_started_at: c.send_started_at,
        send_finished_at: c.send_finished_at,
        public_slug: c.public_slug,
        tags: c.tags,
      },
      totals: {
        ...totals,
        ...evCounts,
        delivery_rate: pct(totals.sent, totals.total),
        open_rate: pct(totals.unique_opens, denom),
        click_rate: pct(totals.unique_clicks, denom),
        unsubscribe_rate: pct(evCounts.unsubscribes, denom),
        bounce_rate: pct(totals.bounced, totals.total),
      },
      timeline,
      links,
      topOpeners,
      topClickers,
      devices,
    };
  });

  app.get('/api/campaigns/:id/recipients', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const params: unknown[] = [id];
    const clauses = ['r.campaign_id = $1'];
    if (q.status) {
      params.push(q.status);
      clauses.push(`r.status = $${params.length}`);
    }
    if (q.event === 'opened') clauses.push('r.opened_at is not null');
    if (q.event === 'clicked') clauses.push('r.clicked_at is not null');
    if (q.event === 'not_opened') clauses.push("r.opened_at is null and r.status = 'sent'");

    const limit = Math.min(Number(q.limit) || 100, 1000);
    const offset = Number(q.offset) || 0;
    const where = clauses.join(' and ');
    const total = await one<{ count: number }>(
      `select count(*)::int as count from campaign_recipients r where ${where}`,
      params
    );
    const rows = await many(
      `select r.id, r.email, r.status, r.error, r.sent_at, r.opened_at, r.clicked_at, r.open_count, r.click_count
         from campaign_recipients r where ${where} order by r.id limit ${limit} offset ${offset}`,
      params
    );
    return { recipients: rows, total: total?.count ?? 0 };
  });

  app.get('/api/campaigns/:id/stats/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await many<any>(
      `select email, status, sent_at, opened_at, clicked_at, open_count, click_count, error
         from campaign_recipients where campaign_id = $1 order by id`,
      [id]
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="campaign-${id}-stats.csv"`);
    return toCsv(
      rows.map((r) => ({
        이메일: r.email,
        발송상태: r.status,
        발송시각: r.sent_at,
        오픈시각: r.opened_at,
        클릭시각: r.clicked_at,
        오픈수: r.open_count,
        클릭수: r.click_count,
        오류: r.error ?? '',
      }))
    );
  });

  /** 기간·주소록·태그로 묶어 보는 전체 발송 통계 */
  app.get('/api/stats/overview', async (req) => {
    const q = req.query as Record<string, string>;
    const params: unknown[] = [];
    const clauses = [`c.status = 'sent'`];

    if (q.from) {
      params.push(q.from);
      clauses.push(`c.send_finished_at >= $${params.length}::timestamptz`);
    }
    if (q.to) {
      params.push(q.to);
      clauses.push(`c.send_finished_at <= $${params.length}::timestamptz`);
    }
    if (q.listIds) {
      params.push(q.listIds.split(','));
      clauses.push(`c.list_id = any($${params.length}::uuid[])`);
    }
    if (q.tags) {
      params.push(q.tags.split(','));
      clauses.push(`c.tags && $${params.length}::text[]`);
    }
    const where = clauses.join(' and ');

    const summary = await one<any>(
      `select coalesce(sum(sent_count),0)::int         as sent,
              coalesce(sum(total_count),0)::int        as total,
              coalesce(sum(unique_open_count),0)::int  as opens,
              coalesce(sum(unique_click_count),0)::int as clicks,
              coalesce(sum(unsub_count),0)::int        as unsubscribes,
              count(*)::int                            as campaigns
         from campaigns c where ${where}`,
      params
    );

    const bucket = q.interval === 'month' ? 'month' : 'week';
    const series = await many<any>(
      `select date_trunc('${bucket}', c.send_finished_at) as bucket,
              coalesce(sum(c.sent_count),0)::int         as sent,
              coalesce(sum(c.unique_open_count),0)::int  as opens,
              coalesce(sum(c.unique_click_count),0)::int as clicks,
              coalesce(sum(c.unsub_count),0)::int        as unsubscribes
         from campaigns c where ${where}
        group by 1 order by 1`,
      params
    );

    const campaigns = await many<any>(
      `select c.id, c.subject, c.send_finished_at, c.total_count, c.sent_count,
              c.unique_open_count, c.unique_click_count, c.unsub_count, c.tags,
              l.name as list_name
         from campaigns c left join lists l on l.id = c.list_id
        where ${where}
        order by c.send_finished_at desc limit 100`,
      params
    );

    return {
      summary: {
        ...summary,
        delivery_rate: pct(summary.sent, summary.total),
        open_rate: pct(summary.opens, summary.sent),
        click_rate: pct(summary.clicks, summary.sent),
        unsubscribe_rate: pct(summary.unsubscribes, summary.sent),
      },
      series: series.map((s) => ({
        ...s,
        open_rate: pct(s.opens, s.sent),
        click_rate: pct(s.clicks, s.sent),
      })),
      campaigns,
    };
  });

  /** 대시보드: 최근 발송 + 구독자 추이 */
  app.get('/api/stats/dashboard', async () => {
    const latest = await one<any>(
      `select id, subject, total_count, sent_count, unique_open_count, unique_click_count, unsub_count,
              send_finished_at
         from campaigns where status = 'sent' order by send_finished_at desc limit 1`
    );
    const previous = await one<any>(
      `select sent_count, total_count, unique_open_count, unique_click_count, unsub_count
         from campaigns where status = 'sent' order by send_finished_at desc offset 1 limit 1`
    );

    const growth = await many<any>(
      `select to_char(date_trunc('month', d), 'YYYY-MM') as month,
              (select count(*) from subscribers s
                where s.subscribed_at < date_trunc('month', d) + interval '1 month'
                  and (s.unsubscribed_at is null or s.unsubscribed_at >= date_trunc('month', d) + interval '1 month')
                  and s.status <> 'deleted')::int as subscribers
         from generate_series(date_trunc('month', now()) - interval '12 months', date_trunc('month', now()), interval '1 month') d
        order by 1`
    );

    const recent = await many<any>(
      `select id, subject, send_finished_at, sent_count, total_count, unique_open_count, unique_click_count
         from campaigns where status = 'sent' order by send_finished_at desc limit 5`
    );

    const listTotals = await one<any>(
      `select count(*) filter (where status = 'subscribed')::int as subscribed,
              count(*) filter (where status = 'unsubscribed')::int as unsubscribed
         from subscribers`
    );

    return {
      latest: latest
        ? {
            ...latest,
            delivery_rate: pct(latest.sent_count, latest.total_count),
            open_rate: pct(latest.unique_open_count, latest.sent_count),
            click_rate: pct(latest.unique_click_count, latest.sent_count),
            unsubscribe_rate: pct(latest.unsub_count, latest.sent_count),
            delta: previous
              ? {
                  delivery: pct(latest.sent_count, latest.total_count) - pct(previous.sent_count, previous.total_count),
                  open: pct(latest.unique_open_count, latest.sent_count) - pct(previous.unique_open_count, previous.sent_count),
                  click: pct(latest.unique_click_count, latest.sent_count) - pct(previous.unique_click_count, previous.sent_count),
                  unsubscribe: pct(latest.unsub_count, latest.sent_count) - pct(previous.unsub_count, previous.sent_count),
                }
              : null,
          }
        : null,
      growth,
      recent: recent.map((r) => ({
        ...r,
        open_rate: pct(r.unique_open_count, r.sent_count),
        click_rate: pct(r.unique_click_count, r.sent_count),
      })),
      subscribers: listTotals,
    };
  });
}

function pct(part: number, whole: number) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
