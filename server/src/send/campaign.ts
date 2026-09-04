import { config } from '../config.js';
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

  for (const r of batch) {
    const started = Date.now();
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
      await query(
        `update campaign_recipients set status = 'sent', message_id = $2, sent_at = now(), error = null where id = $1`,
        [r.id, res.messageId]
      );
      sent++;
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
      await query(`update campaign_recipients set status = 'failed', error = $2 where id = $1`, [r.id, message]);
      failed++;
    }

    const elapsed = Date.now() - started;
    if (elapsed < interval) await sleep(interval - elapsed);
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
    await query(
      `update campaigns set status = 'sent', send_finished_at = now(), updated_at = now() where id = $1`,
      [campaignId]
    );
  }

  return { sent, failed, remaining };
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
