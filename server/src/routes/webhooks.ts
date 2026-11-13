import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { alert, pct } from '../lib/alert.js';
import { one, query } from '../db/pool.js';
import {
  fetchSnsCert,
  isSnsSubscribeUrl,
  SnsCertFetchError,
  verifySnsMessage,
  type SnsCertLoader,
  type SnsMessage,
} from '../lib/sns.js';

/** 테스트에서 네트워크를 타지 않도록 바깥으로 나가는 부분을 갈아 끼울 수 있다. */
export interface WebhookOptions {
  /** 서명 인증서(PEM) 로더. 기본은 SNS 호스트에서만 받아 메모리에 캐시한다. */
  loadCert?: SnsCertLoader;
  /** 구독 확인 주소 호출. */
  confirmSubscription?: (url: string) => Promise<void>;
  /** 받아들일 토픽 ARN. 비어 있으면 서명만 본다. 기본은 MAILROOM_SNS_TOPIC_ARNS. */
  topicArns?: readonly string[];
}

/**
 * SES 이벤트 수신 (SNS HTTPS 구독).
 * 바운스/스팸신고를 받아 전역 차단 목록에 넣고 캠페인 통계에 반영한다.
 * SES 구성 세트에 이벤트 대상(SNS)을 걸어야 들어온다.
 *
 * 인터넷에 열린 주소라 SNS 서명이 맞는 메시지만 처리한다. 서명이 없으면(원시 전달 포함)
 * 아무것도 하지 않고 403 으로 거절한다.
 */
export async function webhookRoutes(app: FastifyInstance, opts: WebhookOptions = {}) {
  const loadCert = opts.loadCert ?? fetchSnsCert;
  const confirmSubscription =
    opts.confirmSubscription ??
    (async (url: string) => {
      await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    });
  const topicArns = new Set(opts.topicArns ?? config.sns.topicArns);

  app.post('/api/webhooks/ses', async (req, reply) => {
    // SNS 는 본문이 JSON 인데 content-type 을 text/plain 으로 보낸다(문자열로 들어온다).
    const raw = typeof req.body === 'string' ? safeJson(req.body) : (req.body as any);
    if (!raw || typeof raw !== 'object') return reply.code(400).send({ ok: false });

    let sns: SnsMessage;
    try {
      sns = await verifySnsMessage(raw, loadCert);
    } catch (err) {
      if (err instanceof SnsCertFetchError) {
        // 메시지 탓이 아니다 — 5xx 로 답해 SNS 가 다시 보내게 한다.
        req.log.error({ err: err.message }, 'SNS 서명 인증서 조회 실패');
        return reply.code(503).send({ ok: false });
      }
      req.log.warn({ err: (err as Error).message, ip: req.ip }, 'SNS 서명 검증 실패 — 거절');
      return reply.code(403).send({ ok: false });
    }

    // 서명이 맞아도 남의 토픽일 수 있다(누구나 자기 토픽을 이 주소에 구독시킬 수 있다).
    if (topicArns.size > 0 && !topicArns.has(sns.TopicArn)) {
      req.log.warn({ topic: sns.TopicArn }, '허용되지 않은 SNS 토픽 — 거절');
      return reply.code(403).send({ ok: false });
    }

    // SNS 구독 확인 — URL을 한 번 호출해 주면 구독이 활성화된다.
    if (sns.Type === 'SubscriptionConfirmation') {
      if (isSnsSubscribeUrl(sns.SubscribeURL)) {
        await confirmSubscription(sns.SubscribeURL).catch(() => {});
        req.log.info({ topic: sns.TopicArn }, 'SNS 구독 확인 완료');
      } else {
        req.log.warn({ url: sns.SubscribeURL }, 'SNS 주소가 아닌 SubscribeURL 무시');
      }
      return { ok: true };
    }

    // 구독 해지 통지 — 할 일이 없다. SubscribeURL 을 부르면 다시 구독되므로 부르지 않는다.
    if (sns.Type === 'UnsubscribeConfirmation') {
      req.log.warn({ topic: sns.TopicArn }, 'SNS 구독이 해지됐습니다');
      return { ok: true };
    }

    const message = safeJson(sns.Message);
    if (!message || typeof message !== 'object') return { ok: true };

    await handleSesEvent(message);
    return { ok: true };
  });
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

  // 발송 결과는 묶어서 기록하므로 바운스가 message_id 보다 먼저 올 수 있다.
  // 그때는 발송 때 붙인 태그로 찾는다.
  type Recipient = { id: number; campaign_id: string; subscriber_id: string | null; email: string };
  const tagged = Number(msg.mail?.tags?.mr_recipient?.[0]) || null;
  const recipient =
    (await one<Recipient>(
      'select id, campaign_id, subscriber_id, email from campaign_recipients where message_id = $1',
      [messageId]
    )) ??
    (tagged
      ? await one<Recipient>(
          'select id, campaign_id, subscriber_id, email from campaign_recipients where id = $1 and message_id is null',
          [tagged]
        )
      : null);

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
        // 수신 서버가 돌려준 진단 코드를 남긴다 — '계정 없음'인지 '차단'인지는 이걸로만 구분된다.
        const diagnostic: string | undefined = (msg.bounce?.bouncedRecipients ?? [])
          .map((r: any) => r.diagnosticCode)
          .find(Boolean)
          ?.slice(0, 300);
        await query(`update campaign_recipients set status = 'bounced', error = $2 where id = $1`, [
          recipient.id,
          [msg.bounce?.bounceSubType ?? 'bounce', diagnostic].filter(Boolean).join(': ').slice(0, 500),
        ]);
        await recordEvent(recipient, 'bounce', { hard, subType: msg.bounce?.bounceSubType, diagnostic });
        // 발송 후에 바운스가 오므로 sent_count 를 같이 줄이지 않으면 두 수치가 어긋난다.
        await query(
          `update campaigns set bounce_count = bounce_count + 1,
                                sent_count = greatest(sent_count - 1, 0)
            where id = $1`,
          [recipient.campaign_id]
        );
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
        await warnOnComplaintRate(recipient.campaign_id);
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

/**
 * 스팸 신고 비율이 0.1% 를 넘으면 SES 가 발송을 조인다. 넘어서는 순간 한 번만 알린다
 * (그 뒤로도 계속 오르면 신고가 들어올 때마다 울려서 시끄럽다).
 */
const COMPLAINT_LIMIT = 0.001;

async function warnOnComplaintRate(campaignId: string) {
  const c = await one<{ subject: string; sent_count: number; complaint_count: number }>(
    'select subject, sent_count, complaint_count from campaigns where id = $1',
    [campaignId]
  );
  if (!c || c.sent_count < 500) return; // 표본이 작으면 비율이 요동친다
  const rate = c.complaint_count / c.sent_count;
  const before = (c.complaint_count - 1) / c.sent_count;
  if (rate <= COMPLAINT_LIMIT || before > COMPLAINT_LIMIT) return;

  await alert('error', `스팸 신고가 한계를 넘었습니다: ${c.subject}`, [
    `신고 ${c.complaint_count}건 / 발송 ${c.sent_count.toLocaleString('ko-KR')}통 (${pct(c.complaint_count, c.sent_count)})`,
    'SES 는 0.1% 를 넘으면 발송을 조입니다. 대상과 동의 여부를 확인하세요.',
    `${config.adminUrl}/emails/${campaignId}`,
  ]);
}
