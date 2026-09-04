import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { randomToken } from '../lib/crypto.js';
import { page } from '../lib/page.js';
import { escapeHtml } from '../render/html.js';
import { formatFrom, mailProvider } from './provider.js';

/**
 * 구독 확인 이메일(더블 옵트인).
 * 폼으로 신청하면 pending 으로 넣고, 메일의 버튼을 눌러야 subscribed 가 된다.
 * 이게 있어야 남의 주소를 함부로 등록하는 걸 막고 스팸 신고율도 낮다.
 */

const TTL_HOURS = 72;

export async function sendConfirmEmail(listId: string, subscriberId: string, email: string) {
  const list = await one<{
    name: string;
    default_sender_name: string | null;
    default_sender_email: string | null;
    footer_company: string | null;
    footer_address: string | null;
    footer_phone: string | null;
    form_language: string;
  }>(
    `select name, default_sender_name, default_sender_email,
            footer_company, footer_address, footer_phone, form_language
       from lists where id = $1`,
    [listId]
  );
  if (!list?.default_sender_email) {
    throw new Error('주소록에 발신자 이메일이 없어 구독 확인 메일을 보낼 수 없습니다.');
  }

  const token = randomToken(24);
  await query(
    `insert into subscriber_tokens (token, list_id, subscriber_id, kind, expires_at)
     values ($1, $2, $3, 'confirm', now() + ($4 || ' hours')::interval)`,
    [token, listId, subscriberId, String(TTL_HOURS)]
  );

  const url = `${config.publicUrl}/c/${token}`;
  const en = list.form_language === 'en';
  const subject = en
    ? `Please confirm your subscription to ${list.name}`
    : `[${list.name}] 구독 확인을 완료해 주세요`;

  const html = confirmHtml({
    listName: list.name,
    url,
    email,
    en,
    footer: [list.footer_company, list.footer_address, list.footer_phone].filter(Boolean) as string[],
  });

  await mailProvider().send({
    to: email,
    from: formatFrom(list.default_sender_name, list.default_sender_email),
    subject,
    html,
    text: en
      ? `Confirm your subscription to ${list.name}: ${url}`
      : `${list.name} 구독 확인: ${url}`,
  });
}

/** 토큰을 소모하고 구독을 확정한다. 이미 쓴 토큰은 다시 통하지 않는다. */
export async function confirmSubscription(token: string) {
  const row = await one<{ subscriber_id: string; list_id: string; used_at: Date | null; expires_at: Date }>(
    `select subscriber_id, list_id, used_at, expires_at from subscriber_tokens
      where token = $1 and kind = 'confirm'`,
    [token]
  );
  if (!row) return { ok: false as const, reason: 'invalid' as const };
  if (row.used_at) return { ok: false as const, reason: 'used' as const };
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    return { ok: false as const, reason: 'expired' as const };
  }

  await query(
    `update subscribers
        set status = 'subscribed', subscribed_at = now(), unsubscribed_at = null, updated_at = now()
      where id = $1`,
    [row.subscriber_id]
  );
  await query('update subscriber_tokens set used_at = now() where token = $1', [token]);

  const sub = await one<{ email: string; list_name: string }>(
    `select s.email, l.name as list_name from subscribers s join lists l on l.id = s.list_id where s.id = $1`,
    [row.subscriber_id]
  );
  return { ok: true as const, email: sub?.email ?? '', listName: sub?.list_name ?? '' };
}

export function confirmResultPage(result: Awaited<ReturnType<typeof confirmSubscription>>) {
  if (result.ok) {
    return page(
      '구독 완료',
      `<p><strong>${escapeHtml(result.email)}</strong> 님의 <strong>${escapeHtml(
        result.listName
      )}</strong> 구독이 완료되었습니다.</p>`
    );
  }
  const messages = {
    invalid: '유효하지 않은 링크입니다.',
    used: '이미 확인이 완료된 링크입니다.',
    expired: '링크가 만료되었습니다. 구독을 다시 신청해 주세요.',
  };
  return page('구독 확인', `<p>${messages[result.reason]}</p>`);
}

function confirmHtml(opts: { listName: string; url: string; email: string; en: boolean; footer: string[] }) {
  const t = opts.en
    ? {
        heading: 'Confirm your subscription',
        body: `Click the button below to start receiving <strong>${escapeHtml(opts.listName)}</strong>.`,
        button: 'Confirm subscription',
        ignore: 'If you did not request this, you can ignore this email.',
      }
    : {
        heading: '구독 확인',
        body: `아래 버튼을 눌러 <strong>${escapeHtml(opts.listName)}</strong> 구독을 완료해 주세요.`,
        button: '구독 확인하기',
        ignore: '본인이 신청하지 않았다면 이 메일을 무시하셔도 됩니다.',
      };

  return `<!doctype html>
<html lang="${opts.en ? 'en' : 'ko'}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0"
         style="width:480px;max-width:100%;background:#fff;border-radius:12px;">
    <tr><td style="padding:36px 32px;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#222;">
      <h1 style="margin:0 0 16px;font-size:20px;">${t.heading}</h1>
      <p style="margin:0 0 8px;font-size:15px;line-height:1.7;">${t.body}</p>
      <p style="margin:0 0 24px;font-size:13px;color:#888;">${escapeHtml(opts.email)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td bgcolor="#e8543f" style="border-radius:6px;">
          <a href="${escapeHtml(opts.url)}" target="_blank"
             style="display:inline-block;padding:13px 26px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;">
            ${t.button}</a>
        </td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:12px;color:#9aa0a6;line-height:1.7;">${t.ignore}</p>
      ${opts.footer.length ? `<p style="margin:16px 0 0;font-size:12px;color:#9aa0a6;line-height:1.7;">${opts.footer.map(escapeHtml).join('<br />')}</p>` : ''}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
