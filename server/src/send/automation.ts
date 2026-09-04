import { many, one, query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { mergeTags } from '../render/merge.js';
import { personalizeTracking, preferencesUrl, unsubscribeUrl, webviewUrl } from '../render/tracking.js';
import {
  assertReady,
  buildSendableHtml,
  fieldDefaults,
  getCampaign,
  prefixAdSubject,
  type CampaignRow,
} from './campaign.js';
import { formatFrom, mailProvider } from './provider.js';

/**
 * 자동 이메일. 구독·오픈·클릭·기념일 같은 사건에 반응해 한 명씩 나간다.
 *
 * 두 단계로 나뉜다.
 *  1) 스캔 — 조건에 새로 걸린 구독자를 찾아 automation_runs 에 예약을 만든다.
 *     (campaign_id, subscriber_id, cycle) 유니크라 같은 사람에게 두 번 예약되지 않는다.
 *  2) 발송 — 시간이 된 예약을 실제로 보낸다.
 *
 * 켜기 전부터 있던 구독자에게 소급 발송하지 않는 것이 중요하다. 웰컴 메일을 켰다고
 * 기존 22,000명에게 "가입을 환영합니다"가 나가면 사고다. 그래서 모든 스캔은
 * campaigns.activated_at 이후에 일어난 사건만 본다.
 */

export interface Trigger {
  type: 'subscribe' | 'campaign_opened' | 'campaign_not_opened' | 'campaign_clicked' | 'field_date';
  /** 사건 발생 후 얼마나 기다렸다 보낼지 */
  delayMinutes?: number;
  /** campaign_* 트리거의 기준 이메일 */
  campaignId?: string;
  /** field_date 트리거가 볼 날짜 필드 key */
  key?: string;
  /** 그 날짜 기준 며칠 전/후 (음수 = 이전) */
  offsetDays?: number;
  /** 보낼 시각(0-23, 서버 시간대) */
  sendHour?: number;
  /** 해마다 반복할지 (생일·가입 기념일) */
  yearly?: boolean;
}

export const TRIGGER_LABELS: Record<Trigger['type'], string> = {
  subscribe: '구독했을 때',
  campaign_opened: '특정 이메일을 오픈했을 때',
  campaign_not_opened: '특정 이메일을 오픈하지 않았을 때',
  campaign_clicked: '특정 이메일의 링크를 클릭했을 때',
  field_date: '특정 날짜 필드 기준',
};

export function validateTrigger(t: Trigger) {
  if (!t?.type || !(t.type in TRIGGER_LABELS)) throw badRequest('알 수 없는 트리거 종류입니다.');
  if (t.type.startsWith('campaign_') && !t.campaignId) throw badRequest('기준이 될 이메일을 선택하세요.');
  if (t.type === 'field_date' && !t.key) throw badRequest('기준이 될 날짜 필드를 선택하세요.');
  if (t.delayMinutes !== undefined && (t.delayMinutes < 0 || t.delayMinutes > 60 * 24 * 365)) {
    throw badRequest('대기 시간이 올바르지 않습니다.');
  }
}

/** 조건에 새로 걸린 구독자를 찾아 예약을 만든다. 예약 건수를 돌려준다. */
export async function scanAutomation(c: CampaignRow & { trigger: Trigger; activated_at: Date | null }) {
  const t = c.trigger ?? ({} as Trigger);
  if (!c.list_id || !c.activated_at) return 0;
  const delay = `${t.delayMinutes ?? 0} minutes`;

  switch (t.type) {
    case 'subscribe': {
      // 켠 이후에 구독한 사람만. 이미 있던 구독자는 건드리지 않는다.
      const res = await query(
        `insert into automation_runs (campaign_id, subscriber_id, scheduled_at)
         select $1::uuid, s.id, s.subscribed_at + $3::interval
           from subscribers s
          where s.list_id = $2 and s.status = 'subscribed' and s.subscribed_at >= $4
         on conflict (campaign_id, subscriber_id, cycle) do nothing`,
        [c.id, c.list_id, delay, c.activated_at]
      );
      return res.rowCount ?? 0;
    }

    case 'campaign_opened':
    case 'campaign_clicked': {
      const evType = t.type === 'campaign_clicked' ? 'click' : 'open';
      const res = await query(
        `insert into automation_runs (campaign_id, subscriber_id, scheduled_at)
         select distinct on (e.subscriber_id) $1::uuid, e.subscriber_id, e.created_at + $3::interval
           from events e
           join subscribers s on s.id = e.subscriber_id
          where e.campaign_id = $4::uuid and e.type = $5
            and e.created_at >= $6
            and e.subscriber_id is not null
            and s.list_id = $2 and s.status = 'subscribed'
          order by e.subscriber_id, e.created_at
         on conflict (campaign_id, subscriber_id, cycle) do nothing`,
        [c.id, c.list_id, delay, t.campaignId, evType, c.activated_at]
      );
      return res.rowCount ?? 0;
    }

    case 'campaign_not_opened': {
      // 대기 시간이 지나도록 안 열었으면 그때 예약을 만든다.
      const res = await query(
        `insert into automation_runs (campaign_id, subscriber_id, scheduled_at)
         select $1::uuid, r.subscriber_id, now()
           from campaign_recipients r
           join subscribers s on s.id = r.subscriber_id
          where r.campaign_id = $3::uuid
            and r.status = 'sent' and r.opened_at is null
            and r.sent_at + $4::interval <= now()
            and r.sent_at >= $5
            and s.list_id = $2 and s.status = 'subscribed'
         on conflict (campaign_id, subscriber_id, cycle) do nothing`,
        [c.id, c.list_id, t.campaignId, delay, c.activated_at]
      );
      return res.rowCount ?? 0;
    }

    case 'field_date': {
      // 필드에 담긴 날짜의 올해 기념일 ± offset. 파싱 안 되는 값은 조용히 지나간다.
      const res = await query(
        `insert into automation_runs (campaign_id, subscriber_id, cycle, scheduled_at)
         select $1::uuid, s.id,
                case when $6 then to_char(now(), 'YYYY') else '' end,
                (date_trunc('year', now())
                   + (make_date(extract(year from now())::int,
                                extract(month from d.val)::int,
                                extract(day from d.val)::int) - date_trunc('year', now())::date)
                   + ($4 || ' days')::interval
                   + ($5 || ' hours')::interval)
           from subscribers s
           cross join lateral (
             select case when s.fields ->> $3 ~ '^\\d{4}-\\d{2}-\\d{2}'
                         then (s.fields ->> $3)::timestamptz end as val
           ) d
          where s.list_id = $2 and s.status = 'subscribed' and d.val is not null
         on conflict (campaign_id, subscriber_id, cycle) do nothing`,
        [c.id, c.list_id, t.key, String(t.offsetDays ?? 0), String(t.sendHour ?? 9), Boolean(t.yearly)]
      );
      return res.rowCount ?? 0;
    }

    default:
      return 0;
  }
}

/** 시간이 된 예약을 실제로 보낸다. */
export async function sendDueAutomations(limit = 100) {
  const due = await many<{ id: number; campaign_id: string; subscriber_id: string }>(
    `select r.id, r.campaign_id, r.subscriber_id
       from automation_runs r
       join campaigns c on c.id = r.campaign_id
      where r.status = 'scheduled' and r.scheduled_at <= now() and c.status = 'active'
      order by r.scheduled_at
      limit $1`,
    [limit]
  );
  if (!due.length) return { sent: 0, skipped: 0, failed: 0 };

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  // 캠페인별로 HTML을 한 번만 만든다.
  const prepared = new Map<string, { c: CampaignRow; html: string; text: string; defaults: Record<string, any> }>();

  for (const run of due) {
    try {
      let p = prepared.get(run.campaign_id);
      if (!p) {
        const c = await getCampaign(run.campaign_id);
        assertReady(c);
        let html = c.content_html;
        let text = '';
        const built = await buildSendableHtml(c);
        // 자동 이메일은 본문을 고치면 다음 발송부터 반영된다 — 매번 새로 굳힌다.
        html = built.html;
        text = built.text;
        if (!c.public_slug) {
          await query('update campaigns set public_slug = $2, content_html = $3 where id = $1', [
            c.id,
            built.slug,
            html,
          ]);
          c.public_slug = built.slug;
        } else {
          await query('update campaigns set content_html = $2 where id = $1', [c.id, html]);
        }
        p = { c, html, text, defaults: await fieldDefaults(c.list_id) };
        prepared.set(run.campaign_id, p);
      }

      const sub = await one<{ email: string; fields: Record<string, unknown>; status: string }>(
        'select email, fields, status from subscribers where id = $1',
        [run.subscriber_id]
      );
      // 예약된 뒤 수신거부했을 수 있다 — 보내기 직전에 다시 확인한다.
      if (!sub || sub.status !== 'subscribed') {
        await query(`update automation_runs set status = 'skipped', error = '수신 대상 아님' where id = $1`, [run.id]);
        skipped++;
        continue;
      }
      const suppressed = await one('select 1 from suppressions where lower(email) = lower($1)', [sub.email]);
      if (suppressed) {
        await query(`update automation_runs set status = 'skipped', error = '수신 차단됨' where id = $1`, [run.id]);
        skipped++;
        continue;
      }

      const recipient = await one<{ id: number }>(
        `insert into campaign_recipients (campaign_id, subscriber_id, email, merge, status)
         values ($1, $2, $3, $4::jsonb, 'sending')
         on conflict (campaign_id, email) do update set status = 'sending', sending_at = now()
         returning id`,
        [p.c.id, run.subscriber_id, sub.email, JSON.stringify({ ...sub.fields, email: sub.email })]
      );

      const links = {
        unsubscribe: unsubscribeUrl(run.subscriber_id),
        preferences: preferencesUrl(run.subscriber_id),
        webview: p.c.public_slug ? webviewUrl(p.c.public_slug) : '#',
      };
      const src = { fields: { ...sub.fields, email: sub.email }, defaults: p.defaults, links };

      const res = await mailProvider().send({
        to: sub.email,
        from: formatFrom(p.c.sender_name, p.c.sender_email!),
        replyTo: p.c.reply_to || undefined,
        subject: mergeTags(prefixAdSubject(p.c.subject, p.c.is_ad), src),
        html: personalizeTracking(mergeTags(p.html, src), recipient!.id),
        text: p.text ? mergeTags(p.text, src) : undefined,
        headers: {
          'List-Unsubscribe': `<${links.unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: { mr_campaign: p.c.id.replace(/-/g, ''), mr_recipient: String(recipient!.id) },
      });

      await query(
        `update campaign_recipients set status = 'sent', message_id = $2, sent_at = now() where id = $1`,
        [recipient!.id, res.messageId]
      );
      await query(
        `update automation_runs set status = 'sent', sent_at = now(), recipient_id = $2 where id = $1`,
        [run.id, recipient!.id]
      );
      await query(
        `update campaigns
            set sent_count = sent_count + 1, total_count = total_count + 1,
                send_started_at = coalesce(send_started_at, now())
          where id = $1`,
        [p.c.id]
      );
      sent++;
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'unknown';
      await query(`update automation_runs set status = 'failed', error = $2 where id = $1`, [run.id, message]);
      await query(`update campaigns set failed_count = failed_count + 1 where id = $1`, [run.campaign_id]);
      failed++;
    }
  }

  return { sent, skipped, failed };
}

/** 활성화된 자동 이메일 전체를 한 바퀴 스캔한다. */
export async function scanAllAutomations() {
  const active = await many<CampaignRow & { trigger: Trigger; activated_at: Date | null }>(
    `select * from campaigns where type = 'automation' and status = 'active'`
  );
  let scheduled = 0;
  for (const c of active) {
    try {
      scheduled += await scanAutomation(c);
    } catch (err) {
      // 하나가 깨져도 나머지는 돌아야 한다.
      console.error(`[automation] 스캔 실패 ${c.id}: ${(err as Error).message}`);
    }
  }
  return scheduled;
}
