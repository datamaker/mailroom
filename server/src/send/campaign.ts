import { config } from '../config.js';
import { alert, pct } from '../lib/alert.js';
import { applyUtm, UTM_DEFAULTS, type UtmConfig } from '../render/utm.js';
import { many, one, query, tx } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { shortId } from '../lib/slug.js';
import { mergeTags } from '../render/merge.js';
import { renderEmailHtml, renderPlainText } from '../render/html.js';
import type { Block, EmailStyles } from '../render/blocks.js';
import {
  appendOpenPixel,
  extractLinks,
  personalizeTracking,
  preferencesUrl,
  rewriteLinks,
  unsubscribeUrl,
  webviewUrl,
} from '../render/tracking.js';
import { buildAudienceQuery, type AudienceTarget } from './audience.js';
import { formatFrom, mailProvider, type OutgoingMessage } from './provider.js';

export interface CampaignRow {
  id: string;
  list_id: string | null;
  name: string | null;
  subject: string;
  preheader: string | null;
  sender_name: string | null;
  sender_email: string | null;
  reply_to: string | null;
  status: string;
  content: Block[];
  styles: EmailStyles;
  content_html: string | null;
  target: AudienceTarget;
  is_ad: boolean;
  track_opens: boolean;
  track_clicks: boolean;
  public_slug: string | null;
  scheduled_at: Date | null;
}

export async function getCampaign(id: string): Promise<CampaignRow> {
  const row = await one<CampaignRow>('select * from campaigns where id = $1', [id]);
  if (!row) throw notFound('이메일을 찾을 수 없습니다.');
  return row;
}

export async function listFooter(listId: string | null) {
  if (!listId) return {};
  const row = await one<{ footer_company: string; footer_address: string; footer_phone: string }>(
    'select footer_company, footer_address, footer_phone from lists where id = $1',
    [listId]
  );
  return { company: row?.footer_company, address: row?.footer_address, phone: row?.footer_phone };
}

export async function fieldDefaults(listId: string | null) {
  if (!listId) return {};
  const rows = await many<{ key: string; default_value: string | null }>(
    'select key, default_value from custom_fields where list_id = $1',
    [listId]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.default_value]));
}

/** 에디터 미리보기와 "HTML 내보내기"가 함께 쓰는 렌더 경로 */
export async function renderCampaign(
  c: CampaignRow,
  opts: { mode?: 'email' | 'web'; sample?: Record<string, unknown> } = {}
) {
  const footer = await listFooter(c.list_id);
  const html = renderEmailHtml(c.content || [], {
    styles: c.styles,
    footer,
    mode: opts.mode,
    webviewUrl: c.public_slug ? webviewUrl(c.public_slug) : undefined,
  });
  if (!opts.sample) return html;
  const defaults = await fieldDefaults(c.list_id);
  return mergeTags(html, { fields: opts.sample, defaults, links: { unsubscribe: '#', preferences: '#', webview: '#' } });
}

/** 발송 가능한 상태인지 확인한다. 일반 발송과 자동 이메일이 같은 기준을 쓴다. */
export function assertReady(
  c: CampaignRow
): asserts c is CampaignRow & { list_id: string; sender_email: string } {
  if (!c.list_id) throw badRequest('주소록이 선택되지 않았습니다.');
  if (!c.sender_email) throw badRequest('발신자 이메일 주소가 없습니다.');
  if (!c.subject.trim()) throw badRequest('제목이 비어 있습니다.');
  if (!Array.isArray(c.content) || c.content.length === 0) throw badRequest('콘텐츠가 비어 있습니다.');
}

/** 캠페인 설정 → 워크스페이스 기본값 → 내장 기본값 순으로 UTM 을 정한다. */
export async function resolveUtm(c: CampaignRow): Promise<UtmConfig> {
  const row = await one<{ value: UtmConfig }>(`select value from settings where key = 'utm'`);
  const cfg: UtmConfig = { ...UTM_DEFAULTS, ...(row?.value ?? {}), ...((c as any).utm ?? {}) };
  // utm_campaign 을 비워 두면 캠페인 이름을 쓴다.
  if (!cfg.campaign?.trim()) cfg.campaign = (c as any).name || c.subject || '';
  return cfg;
}

/**
 * 콘텐츠를 발송용 HTML로 굳히고 추적 링크를 등록한다.
 * 이 시점 이후 캠페인 본문을 고쳐도 이미 나간 메일에는 영향이 없다.
 */
export async function buildSendableHtml(c: CampaignRow) {
  const slug = c.public_slug || shortId(8);
  const footer = await listFooter(c.list_id);

  let html = renderEmailHtml(c.content, {
    styles: c.styles,
    footer,
    mode: 'email',
    webviewUrl: webviewUrl(slug),
  });

  // 링크 등록 전에 UTM 을 붙여야 campaign_links 와 실제 이동 주소가 같아진다.
  html = applyUtm(html, await resolveUtm(c), config.publicUrl);

  if (c.track_clicks) {
    const links = extractLinks(html);
    const ids = new Map<string, number>();
    for (const link of links) {
      const row = await one<{ id: number }>(
        `insert into campaign_links (campaign_id, url) values ($1, $2)
         on conflict (campaign_id, url) do update set url = excluded.url
         returning id`,
        [c.id, link.url]
      );
      if (row) ids.set(link.url, row.id);
    }
    html = rewriteLinks(html, ids);
  }
  if (c.track_opens) html = appendOpenPixel(html);

  return { html, slug, text: renderPlainText(c.content) };
}

/**
 * 발송 준비: 콘텐츠 스냅샷 + 링크 등록 + 수신자 확정.
 * 여기까지 끝나면 캠페인 내용을 바꿔도 이미 큐에 들어간 발송에는 영향이 없다.
 */
export async function prepareCampaign(campaignId: string) {
  const c = await getCampaign(campaignId);
  assertReady(c);

  const { html, slug, text } = await buildSendableHtml(c);

  // 수신자 스냅샷. 여기서 확정된 명단으로만 나간다.
  const { where, params } = await buildAudienceQuery(c.list_id, c.target || {});
  const inserted = await query(
    `insert into campaign_recipients (campaign_id, subscriber_id, email, merge)
     select $${params.length + 1}::uuid, s.id, s.email,
            jsonb_build_object('email', s.email) || s.fields
       from subscribers s
      where ${where}
     on conflict (campaign_id, email) do nothing`,
    [...params, c.id]
  );

  const total = await one<{ count: number }>(
    'select count(*)::int as count from campaign_recipients where campaign_id = $1',
    [c.id]
  );

  await query(
    `update campaigns
        set content_html = $2, public_slug = $3, total_count = $4,
            status = 'sending', send_started_at = coalesce(send_started_at, now()), updated_at = now()
      where id = $1`,
    [c.id, html, slug, total?.count ?? 0]
  );

  return { total: total?.count ?? 0, inserted: inserted.rowCount ?? 0, html, text };
}

export interface SendBatchResult {
  sent: number;
  failed: number;
  remaining: number;
}

/** 큐에서 batchSize 만큼 꺼내 실제로 보낸다. 워커가 반복 호출한다. */
export async function sendCampaignBatch(campaignId: string, batchSize = config.send.batchSize): Promise<SendBatchResult> {
  const c = await getCampaign(campaignId);
  if (!c.content_html) throw badRequest('발송 준비가 되지 않았습니다.');

  const defaults = await fieldDefaults(c.list_id);
  const provider = mailProvider();
  const from = formatFrom(c.sender_name, c.sender_email!);
  const text = renderPlainText(c.content || []);

  // 같은 행을 두 워커가 집지 않도록 잠그고 꺼낸다.
  const batch = await tx(async (client) => {
    const { rows } = await client.query<{
      id: number;
      subscriber_id: string | null;
      email: string;
      merge: Record<string, unknown>;
    }>(
      `select id, subscriber_id, email, merge
         from campaign_recipients
        where campaign_id = $1 and status = 'queued'
        order by id
        limit $2
        for update skip locked`,
      [campaignId, batchSize]
    );
    if (rows.length) {
      await client.query(
        `update campaign_recipients set status = 'sending', sending_at = now() where id = any($1::bigint[])`,
        [rows.map((r) => r.id)]
      );
    }
    return rows;
  });

  let sent = 0;
  let failed = 0;
  const interval = 1000 / Math.max(1, config.send.rateLimit);

  // 결과는 모았다가 한 번에 쓴다. 너무 오래 모으면 워커가 죽었을 때 '보냈는데
  // 기록 안 된' 행이 reaper 에 의해 다시 나가므로 1초 남짓마다 비운다.
  const results: Outcome[] = [];
  const flushEvery = Math.max(10, config.send.rateLimit);
  const flush = async () => {
    if (!results.length) return;
    await recordOutcomes(results.splice(0));
  };

  const sendOne = async (r: (typeof batch)[number]): Promise<Outcome> => {
    const links = {
      unsubscribe: r.subscriber_id ? unsubscribeUrl(r.subscriber_id) : '#',
      preferences: r.subscriber_id ? preferencesUrl(r.subscriber_id) : '#',
      webview: c.public_slug ? webviewUrl(c.public_slug) : '#',
    };
    const src = { fields: { ...r.merge, email: r.email }, defaults, links };

    const html = personalizeTracking(mergeTags(c.content_html!, src), r.id);
    const subject = mergeTags(prefixAdSubject(c.subject, c.is_ad), src);

    const msg: OutgoingMessage = {
      to: r.email,
      from,
      replyTo: c.reply_to || undefined,
      subject,
      html,
      text: text ? mergeTags(text, src) : undefined,
      headers: {
        // 메일 클라이언트의 원클릭 수신거부. 스팸 신고 대신 이쪽으로 유도된다.
        'List-Unsubscribe': `<${links.unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: { mr_campaign: c.id.replace(/-/g, ''), mr_recipient: String(r.id) },
    };

    try {
      const res = await provider.send(msg);
      return { id: r.id, status: 'sent', messageId: res.messageId };
    } catch (err) {
      // 한도 초과는 이 사람 탓이 아니다 — 실패로 굳히지 말고 큐로 돌린다.
      if (isThrottle(err)) return { id: r.id, status: 'queued' };
      return { id: r.id, status: 'failed', error: (err as Error).message?.slice(0, 500) ?? 'unknown error' };
    }
  };

  // 시작 간격으로 rateLimit 을 지키고, 응답은 concurrency 개까지 겹쳐 기다린다.
  const inflight = new Set<Promise<void>>();
  let nextAt = Date.now();
  let stopped: string | null = null;
  let i = 0;

  for (; i < batch.length; i++) {
    if (i % flushEvery === 0) {
      await flush();
      stopped = await shouldStop(campaignId);
      if (stopped) break;
    }
    while (inflight.size >= config.send.concurrency) await Promise.race(inflight);
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    // 밀렸을 때 몰아서 쏘지 않도록 지금 기준으로 다시 잡는다.
    nextAt = Math.max(nextAt, Date.now()) + interval;

    const r = batch[i];
    const p = sendOne(r)
      .catch((err): Outcome => ({ id: r.id, status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 500) }))
      .then((o) => {
        results.push(o);
        if (o.status === 'sent') sent++;
        else if (o.status === 'failed') failed++;
      });
    const tracked = p.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  }
  await Promise.all(inflight);
  await flush();

  // 멈췄으면 아직 안 보낸 행을 큐로 돌려 둔다 — 재개하면 거기서 이어진다.
  if (stopped) {
    const rest = batch.slice(i).map((r) => r.id);
    if (rest.length) {
      await query(
        `update campaign_recipients set status = 'queued', sending_at = null
          where id = any($1::bigint[]) and status = 'sending'`,
        [rest]
      );
    }
  }

  const remainingRow = await one<{ count: number }>(
    `select count(*)::int as count from campaign_recipients where campaign_id = $1 and status in ('queued','sending')`,
    [campaignId]
  );
  const remaining = remainingRow?.count ?? 0;

  await query(
    `update campaigns
        set sent_count = (select count(*) from campaign_recipients where campaign_id = $1 and status = 'sent'),
            failed_count = (select count(*) from campaign_recipients where campaign_id = $1 and status = 'failed'),
            updated_at = now()
      where id = $1`,
    [campaignId]
  );

  if (remaining === 0) {
    const done = await one<{ n: number; subject: string; sent_count: number; failed_count: number }>(
      `update campaigns set status = 'sent', send_finished_at = now(), updated_at = now()
        where id = $1 and status <> 'sent'
       returning 1 as n, subject, sent_count, failed_count`,
      [campaignId]
    );
    // returning 이 비면 다른 배치가 이미 마감한 것이다 — 알림을 두 번 보내지 않는다.
    if (done) await announceFinished(campaignId, done);
  }

  return { sent, failed, remaining };
}

interface Outcome {
  id: number;
  status: 'sent' | 'failed' | 'queued';
  messageId?: string;
  error?: string;
}

/**
 * 발송 결과를 한 번에 기록한다. 그 사이 웹훅이 먼저 'bounced' 로 바꿨을 수 있으니
 * 'sending' 인 행만 상태를 덮는다 — message_id 는 어느 쪽이든 채운다.
 */
async function recordOutcomes(rows: Outcome[]) {
  await query(
    `update campaign_recipients r
        set message_id = coalesce(v.message_id, r.message_id),
            status     = case when r.status = 'sending' then v.status else r.status end,
            error      = case when r.status = 'sending' then v.error else r.error end,
            sent_at    = case when v.status = 'sent' then coalesce(r.sent_at, now()) else r.sent_at end,
            sending_at = case when v.status = 'queued' then null else r.sending_at end
       from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) as v(id, status, message_id, error)
      where r.id = v.id`,
    [rows.map((o) => o.id), rows.map((o) => o.status), rows.map((o) => o.messageId ?? null), rows.map((o) => o.error ?? null)]
  );
}

/**
 * 계속 보내도 되는지. 사람이 멈췄거나, 하드 바운스율이 차단 기준을 넘으면 멈춘다.
 * 바운스는 발송 몇 초 뒤에 웹훅으로 들어오므로 실제 비율보다 조금 낮게 보인다.
 */
async function shouldStop(campaignId: string): Promise<string | null> {
  const c = await one<{ status: string; subject: string; attempted: number; hard: number }>(
    `select c.status, c.subject,
            (select count(*) from campaign_recipients
              where campaign_id = c.id and status in ('sent','bounced'))::int as attempted,
            (select count(*) from events
              where campaign_id = c.id and type = 'bounce' and (meta->>'hard')::boolean)::int as hard
       from campaigns c where c.id = $1`,
    [campaignId]
  );
  if (!c) return 'missing';
  if (c.status !== 'sending') return c.status;

  const { rate, minSample } = config.send.bounceGuard;
  if (!rate || c.attempted < minSample || c.hard / c.attempted <= rate) return null;

  // 조건부 update 라 동시에 여러 워커가 걸려도 알림은 한 번만 나간다.
  const paused = await one(
    `update campaigns set status = 'paused', updated_at = now() where id = $1 and status = 'sending' returning 1`,
    [campaignId]
  );
  if (paused) {
    await alert('error', `반송이 많아 발송을 멈췄습니다: ${c.subject}`, [
      `하드 바운스 ${c.hard.toLocaleString('ko-KR')}건 / 발송 ${c.attempted.toLocaleString('ko-KR')}통 (${pct(c.hard, c.attempted)})`,
      `기준 ${pct(rate, 1)} — SES 는 5% 에서 계정 검토, 10% 에서 발송 중지입니다.`,
      '명단 출처를 확인하고 정리한 뒤 재개하세요. 반송된 주소는 이미 차단 목록에 들어갔습니다.',
      `${config.adminUrl}/emails/${campaignId}`,
    ]);
  }
  return 'bounce-guard';
}

function isThrottle(err: unknown) {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'TooManyRequestsException' || e?.name === 'ThrottlingException' || e?.$metadata?.httpStatusCode === 429;
}

/** 발송이 끝났을 때 사람한테 알린다. 실패가 많으면 경고로 올린다. */
async function announceFinished(
  campaignId: string,
  c: { subject: string; sent_count: number; failed_count: number }
) {
  const total = c.sent_count + c.failed_count;
  const rate = total ? c.failed_count / total : 0;
  const bad = rate > config.alertFailureRate;

  const reasons = c.failed_count
    ? await many<{ error: string; n: number }>(
        `select coalesce(substring(error from 1 for 80), '(원인 없음)') as error, count(*)::int as n
           from campaign_recipients where campaign_id = $1 and status = 'failed'
          group by 1 order by 2 desc limit 3`,
        [campaignId]
      )
    : [];

  await alert(bad ? 'warn' : 'info', bad ? `발송 완료 — 실패가 많습니다: ${c.subject}` : `발송 완료: ${c.subject}`, [
    `성공 ${c.sent_count.toLocaleString('ko-KR')}통`,
    `실패 ${c.failed_count.toLocaleString('ko-KR')}통 (${pct(c.failed_count, total)})`,
    ...reasons.map((r) => `${r.error} — ${r.n}건`),
    `${config.adminUrl}/emails/${campaignId}`,
  ]);
}

/** 정보통신망법: 영리 목적 광고성 메일은 제목에 (광고) 표기가 필요하다. */
export function prefixAdSubject(subject: string, isAd: boolean) {
  if (!isAd) return subject;
  if (/^\(광고/.test(subject.trim())) return subject;
  return `(광고) ${subject}`;
}

export async function sendTestEmail(campaignId: string, recipients: string[]) {
  const c = await getCampaign(campaignId);
  if (!c.sender_email) throw badRequest('발신자 이메일 주소가 없습니다.');
  const footer = await listFooter(c.list_id);
  const defaults = await fieldDefaults(c.list_id);
  const provider = mailProvider();
  const from = formatFrom(c.sender_name, c.sender_email);

  const html = renderEmailHtml(c.content || [], {
    styles: c.styles,
    footer,
    mode: 'email',
    webviewUrl: c.public_slug ? webviewUrl(c.public_slug) : '#',
  });

  const out: Array<{ email: string; ok: boolean; error?: string }> = [];
  for (const email of recipients.slice(0, 5)) {
    const src = {
      fields: { email, name: '테스트' },
      defaults,
      links: { unsubscribe: '#', preferences: '#', webview: '#' },
    };
    try {
      await provider.send({
        to: email,
        from,
        replyTo: c.reply_to || undefined,
        subject: `[테스트] ${mergeTags(prefixAdSubject(c.subject, c.is_ad), src)}`,
        html: mergeTags(html, src),
      });
      out.push({ email, ok: true });
    } catch (err) {
      out.push({ email, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
