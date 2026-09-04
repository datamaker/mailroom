import type { FastifyInstance } from 'fastify';
import { one, query } from '../db/pool.js';

/**
 * SES 이벤트 수신 (SNS HTTPS 구독).
 * 바운스/스팸신고를 받아 전역 차단 목록에 넣고 캠페인 통계에 반영한다.
 * SES 구성 세트에 이벤트 대상(SNS)을 걸어야 들어온다.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/ses', async (req, reply) => {
    const raw = typeof req.body === 'string' ? safeJson(req.body) : (req.body as any);
    if (!raw) return reply.code(400).send({ ok: false });

    // SNS 구독 확인 — URL을 한 번 호출해 주면 구독이 활성화된다.
    if (raw.Type === 'SubscriptionConfirmation' && raw.SubscribeURL) {
      if (isAwsUrl(raw.SubscribeURL)) {
        await fetch(raw.SubscribeURL).catch(() => {});
        app.log.info({ topic: raw.TopicArn }, 'SNS 구독 확인 완료');
      } else {
        app.log.warn({ url: raw.SubscribeURL }, 'AWS 도메인이 아닌 SubscribeURL 무시');
      }
      return { ok: true };
    }

    const message = raw.Type === 'Notification' ? safeJson(raw.Message) : raw;
    if (!message) return { ok: true };

    await handleSesEvent(message);
    return { ok: true };
  });
}

function isAwsUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)amazonaws\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function safeJson(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

async function handleSesEvent(msg: any) {
  const type: string = msg.eventType || msg.notificationType;
  const messageId: string | undefined = msg.mail?.messageId;
  if (!type || !messageId) return;

  const recipient = await one<{ id: number; campaign_id: string; subscriber_id: string | null; email: string }>(
    'select id, campaign_id, subscriber_id, email from campaign_recipients where message_id = $1',
    [messageId]
  );

  switch (type) {
    case 'Bounce': {
      const hard = msg.bounce?.bounceType === 'Permanent';
      const addresses: string[] = (msg.bounce?.bouncedRecipients ?? []).map((r: any) => r.emailAddress);
      for (const email of addresses) {
        if (hard) {
          await query(
            `insert into suppressions (email, reason, source, detail) values (lower($1),'hard_bounce','ses',$2)
             on conflict (email) do nothing`,
            [email, msg.bounce?.bounceSubType ?? null]
          );
          // 주소록에서 자동삭제를 켠 곳은 발송 대상에서 뺀다.
          await query(
            `update subscribers s set status = 'deleted', updated_at = now()
               from lists l
              where s.list_id = l.id and l.auto_delete_hard_bounce and lower(s.email) = lower($1)`,
            [email]
          );
        }
      }
      if (recipient) {
        await query(`update campaign_recipients set status = 'bounced', error = $2 where id = $1`, [
          recipient.id,
          msg.bounce?.bounceSubType ?? 'bounce',
        ]);
        await recordEvent(recipient, 'bounce', { hard, subType: msg.bounce?.bounceSubType });
        await query('update campaigns set bounce_count = bounce_count + 1 where id = $1', [recipient.campaign_id]);
      }
      return;
    }

    case 'Complaint': {
      const addresses: string[] = (msg.complaint?.complainedRecipients ?? []).map((r: any) => r.emailAddress);
      for (const email of addresses) {
        await query(
          `insert into suppressions (email, reason, source, detail) values (lower($1),'complaint','ses',$2)
           on conflict (email) do nothing`,
          [email, msg.complaint?.complaintFeedbackType ?? null]
        );
        // 스팸 신고는 사실상 수신거부다.
        await query(
          `update subscribers set status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
            where lower(email) = lower($1) and status = 'subscribed'`,
          [email]
        );
      }
      if (recipient) {
        await recordEvent(recipient, 'complaint', { feedback: msg.complaint?.complaintFeedbackType });
        await query('update campaigns set complaint_count = complaint_count + 1 where id = $1', [recipient.campaign_id]);
      }
      return;
    }

    case 'Delivery': {
      if (recipient) await recordEvent(recipient, 'delivered', {});
      return;
    }

    default:
      // Open/Click 은 우리가 직접 추적한다 — SES 쪽은 무시.
      return;
  }
}

async function recordEvent(
  recipient: { id: number; campaign_id: string; subscriber_id: string | null },
  type: string,
  meta: Record<string, unknown>
) {
  await query(
    `insert into events (campaign_id, recipient_id, subscriber_id, type, meta) values ($1,$2,$3,$4,$5::jsonb)`,
    [recipient.campaign_id, recipient.id, recipient.subscriber_id, type, JSON.stringify(meta)]
  );
}
