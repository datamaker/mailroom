import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, query } from '../db/pool.js';
import { verifyPayload } from '../lib/crypto.js';
import { parseUserAgent } from '../lib/ua.js';
import { parseRecipientToken } from '../render/tracking.js';
import { escapeHtml } from '../render/html.js';
import {
  allowedFieldKeys,
  applySubscriberChanges,
  normalizeEmail,
  publicSubscribe,
  sanitizeFields,
} from '../lib/subscribers.js';
import { encodeAttr } from '../lib/html-entities.js';
import { HttpError, notFound } from '../lib/errors.js';
import { mergeTags } from '../render/merge.js';
import { page } from '../lib/page.js';
import { rateLimit } from '../lib/ratelimit.js';
import { confirmResultPage, confirmSubscription, sendConfirmEmail } from '../send/confirm.js';

/**
 * 구독 신청 제한. 확인 메일을 임의의 주소로 뿌리는 데 악용되지 않게 한다.
 * 사람이 폼을 채우는 속도로는 절대 걸리지 않는 값이다.
 */
const SUBSCRIBE_BY_IP = { windowMs: 60 * 60_000, max: 20 };
const SUBSCRIBE_BY_EMAIL = { windowMs: 60 * 60_000, max: 3 };

function throttleSubscribe(ip: string | null, email: string) {
  const byIp = rateLimit(`sub:ip:${ip ?? 'unknown'}`, SUBSCRIBE_BY_IP);
  if (!byIp.ok) return byIp;
  return rateLimit(`sub:em:${email}`, SUBSCRIBE_BY_EMAIL);
}

/** 1x1 투명 GIF */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export async function publicRoutes(app: FastifyInstance) {
  // ---- 오픈 추적 ----
  app.get('/t/o/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const clean = token.replace(/\.gif$/, '');
    reply.header('content-type', 'image/gif');
    reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    try {
      await recordOpen(clean, req.headers['user-agent'], clientIp(req));
    } catch {
      // 추적 실패로 픽셀이 깨지면 안 된다.
    }
    return reply.send(PIXEL);
  });

  // ---- 클릭 추적 ----
  app.get('/t/c/:token/:linkId', async (req, reply) => {
    const { token, linkId } = req.params as { token: string; linkId: string };
    // 토큰(서명된 수신자 id)이 맞고, 그 수신자가 받은 캠페인의 링크일 때만 이동시킨다.
    // 예전엔 토큰이 틀려도 리다이렉트해서, linkId 를 1부터 세어 올리면 모든 캠페인의
    // 링크 주소를 긁어 갈 수 있었고 우리 도메인이 아무 데로나 보내 주는 중계기 노릇도 했다.
    const gone = () => reply.code(404).type('text/plain; charset=utf-8').send('링크를 찾을 수 없습니다.');
    if (!/^\d{1,15}$/.test(linkId)) return gone();
    const payload = verifyPayload(token);
    const recipientId = payload ? parseRecipientToken(payload) : null;
    if (!recipientId) return gone();

    const link = await one<{ url: string; campaign_id: string }>(
      `select l.url, l.campaign_id
         from campaign_links l
         join campaign_recipients r on r.campaign_id = l.campaign_id
        where l.id = $1 and r.id = $2`,
      [linkId, recipientId]
    );
    if (!link) return gone();
    try {
      await recordClick(token, Number(linkId), link.campaign_id, req.headers['user-agent'], clientIp(req));
    } catch {
      // 통계 기록 실패가 이동을 막지 않는다.
    }
    return reply.redirect(link.url, 302);
  });

  // ---- 웹에서 보기 ----
  app.get('/w/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    // 이 링크는 받은 메일 안에 들어 있다 — 한 통이라도 나갔으면 연다.
    // 상태(sent)로 판단하면 발송이 끝나기 전 몇 시간 동안 먼저 받은 사람이 404를 본다.
    // 자동 이메일은 status 가 active 라서 상태로는 아예 열리지 않는다.
    const c = await one<{ id: string; content_html: string; public_visibility: string; delivered: boolean }>(
      `select c.id, c.content_html, c.public_visibility,
              exists (select 1 from campaign_recipients r
                       where r.campaign_id = c.id and r.status in ('sent', 'bounced')) as delivered
         from campaigns c where c.public_slug = $1`,
      [slug]
    );
    if (!c || !c.content_html) throw notFound('이메일을 찾을 수 없습니다.');
    if (c.public_visibility !== 'public' && !c.delivered) throw notFound('공개되지 않은 이메일입니다.');
    // 웹뷰에는 수신자가 없다. 추적 자리표시자를 비우고, 메일머지 태그도 지운다 —
    // 안 그러면 방문자에게 $%name%$ 같은 원본 태그가 그대로 보인다.
    // 웹뷰에는 수신자 토큰이 없어 추적 링크(/t/c/…)가 통하지 않는다 — 원래 주소로 되돌려 놓는다.
    const links = await many<{ id: string; url: string }>(
      'select id, url from campaign_links where campaign_id = $1',
      [c.id]
    );
    const original = new Map(links.map((l) => [String(l.id), l.url]));
    const untracked = c.content_html.replace(
      /href="[^"]*\/t\/c\/__MR_RCPT__\/(\d+)"/g,
      (full, id: string) => (original.has(id) ? `href="${encodeAttr(original.get(id)!)}"` : full)
    );
    const html = mergeTags(
      untracked.split('__MR_RCPT__').join('web'),
      {
        fields: {},
        links: { unsubscribe: `${config.publicUrl}/u/expired`, preferences: '#', webview: '#' },
      },
      'html'
    );
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(html);
  });

  // ---- 수신거부 ----
  app.get('/u/:token', async (req, reply) => {
    const sub = await subscriberFromToken((req.params as any).token, 'u');
    if (!sub) return reply.code(404).type('text/html').send(page('수신거부', '<p>유효하지 않은 링크입니다.</p>'));
    reply.type('text/html');
    if (sub.status === 'unsubscribed') {
      return page('수신거부 완료', `<p><strong>${escapeHtml(sub.email)}</strong> 님은 이미 수신거부 상태입니다.</p>`);
    }
    return page(
      '수신거부',
      `<p><strong>${escapeHtml(sub.email)}</strong> 님, <strong>${escapeHtml(sub.list_name)}</strong> 뉴스레터 수신을 거부하시겠습니까?</p>
       <form method="post"><button type="submit" class="danger">수신거부</button></form>`
    );
  });

  /** RFC 8058 원클릭 수신거부 — 메일 클라이언트가 POST를 그대로 쏜다. */
  app.post('/u/:token', async (req, reply) => {
    const token = (req.params as any).token;
    const sub = await subscriberFromToken(token, 'u');
    if (!sub) return reply.code(404).type('text/html').send(page('수신거부', '<p>유효하지 않은 링크입니다.</p>'));

    await query(
      `update subscribers set status = 'unsubscribed', unsubscribed_at = now(), updated_at = now() where id = $1`,
      [sub.id]
    );
    const recent = await one<{ campaign_id: string }>(
      `select campaign_id from campaign_recipients
        where subscriber_id = $1 and sent_at is not null order by sent_at desc limit 1`,
      [sub.id]
    );
    await query(
      `insert into events (campaign_id, subscriber_id, type, user_agent, ip) values ($1,$2,'unsubscribe',$3,$4)`,
      [recent?.campaign_id ?? null, sub.id, req.headers['user-agent'] ?? null, clientIp(req)]
    );
    if (recent?.campaign_id) {
      await query('update campaigns set unsub_count = unsub_count + 1 where id = $1', [recent.campaign_id]);
    }

    reply.type('text/html');
    return page(
      '수신거부 완료',
      `<p><strong>${escapeHtml(sub.email)}</strong> 님의 수신거부가 처리되었습니다.</p>
       <p class="muted">더 이상 <strong>${escapeHtml(sub.list_name)}</strong> 이메일을 받지 않습니다.</p>`
    );
  });

  // ---- 구독 정보 변경 ----
  app.get('/p/:token', async (req, reply) => {
    const sub = await subscriberFromToken((req.params as any).token, 'p');
    if (!sub) return reply.code(404).type('text/html').send(page('구독 정보', '<p>유효하지 않은 링크입니다.</p>'));
    const fields = await many<any>(
      `select key, label, type, required from custom_fields where list_id = $1 and key <> 'email' order by position`,
      [sub.list_id]
    );
    const inputs = fields
      .map(
        (f) =>
          `<label>${escapeHtml(f.label)}<input name="${escapeHtml(f.key)}" value="${escapeHtml(
            (sub.fields as any)?.[f.key] ?? ''
          )}" /></label>`
      )
      .join('');
    reply.type('text/html');
    return page(
      '구독 정보 변경',
      `<p class="muted">${escapeHtml(sub.email)}</p>
       <form method="post">
         ${inputs}
         <label class="check"><input type="checkbox" name="ad_agreed" ${sub.ad_agreed ? 'checked' : ''} /> 광고성 정보 수신에 동의합니다</label>
         <button type="submit">저장하기</button>
       </form>
       <p class="muted"><a href="/u/${escapeHtml(sub.unsubToken)}">수신거부</a></p>`
    );
  });

  app.post('/p/:token', async (req, reply) => {
    const sub = await subscriberFromToken((req.params as any).token, 'p');
    if (!sub) return reply.code(404).type('text/html').send(page('구독 정보', '<p>유효하지 않은 링크입니다.</p>'));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { ad_agreed, ...rest } = body;
    // 토큰으로 본인임은 확인됐다. 그래도 바꿀 수 있는 건 이 주소록에 정의된 필드뿐이다 —
    // 폼에 없는 키를 끼워 보내 레코드에 임의의 값을 쌓지 못하게.
    await applySubscriberChanges(sub.id, sub.list_id, {
      fields: sanitizeFields(rest, await allowedFieldKeys(sub.list_id)),
      adAgreed: ad_agreed === 'on' || ad_agreed === 'true',
    });
    reply.type('text/html');
    return page('구독 정보 변경', '<p>변경 사항을 저장했습니다.</p>');
  });

  // ---- 구독 확인 ----
  app.get('/c/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.type('text/html');
    return confirmResultPage(await confirmSubscription(token));
  });

  // ---- 구독 폼 ----
  app.get('/s/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const list = await one<any>('select * from lists where slug = $1', [slug]);
    if (!list || !list.form_enabled) throw notFound('구독 폼을 찾을 수 없습니다.');
    const fields = await many<any>(
      `select key, label, type, required from custom_fields
        where list_id = $1 and show_on_form and key <> 'email' order by position`,
      [list.id]
    );
    const inputs = fields
      .map(
        (f) =>
          `<label>${escapeHtml(f.label)}${f.required ? ' *' : ''}<input name="${escapeHtml(f.key)}" ${
            f.required ? 'required' : ''
          } /></label>`
      )
      .join('');
    reply.type('text/html');
    return page(
      list.form_title || list.name,
      `${list.form_description ? `<p class="muted">${escapeHtml(list.form_description)}</p>` : ''}
       <form method="post">
         <label>이메일 주소 *<input type="email" name="email" required /></label>
         ${inputs}
         <label class="check"><input type="checkbox" name="ad_agreed" /> 광고성 정보 수신에 동의합니다</label>
         <button type="submit">구독하기</button>
       </form>`
    );
  });

  app.post('/s/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const list = await one<any>('select * from lists where slug = $1', [slug]);
    if (!list || !list.form_enabled) throw notFound('구독 폼을 찾을 수 없습니다.');

    const body = (req.body ?? {}) as Record<string, string>;
    const { email, ad_agreed, ...fields } = body;
    const clean = normalizeEmail(email);

    const limited = throttleSubscribe(clientIp(req), clean);
    if (!limited.ok) {
      reply.type('text/html').code(429);
      return page('구독 신청', '<p>요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.</p>');
    }

    // 이미 있는 구독자는 여기서 바뀌지 않는다 — 바꿀 내용은 확인 메일의 토큰에 실린다.
    const outcome = await publicSubscribe(list, {
      email: clean,
      fields,
      adAgreed: ad_agreed === 'on' || ad_agreed === 'true',
    });

    reply.type('text/html');
    if (outcome.result === 'skipped') {
      return page('구독 신청', `<p>${escapeHtml(outcome.reason ?? '처리할 수 없습니다.')}</p>`);
    }
    if (outcome.needsConfirm && outcome.id) {
      try {
        await sendConfirmEmail(list.id, outcome.id, clean, outcome.changes);
      } catch (err) {
        req.log.error({ err }, '구독 확인 메일 발송 실패');
        return page(
          '구독 신청',
          `<p>구독 확인 이메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.</p>`
        );
      }
      return page(
        '구독 신청 완료',
        `<p><strong>${escapeHtml(clean)}</strong> 로 구독 확인 이메일을 보냈습니다.</p>
         <p class="muted">메일의 확인 버튼을 눌러야 구독이 완료됩니다.</p>`
      );
    }
    return page('구독 완료', `<p><strong>${escapeHtml(clean)}</strong> 구독이 완료되었습니다.</p>`);
  });

  /** 외부 사이트에 붙이는 JSON 엔드포인트 (구독폼을 직접 만들 때) */
  app.post('/api/public/lists/:slug/subscribe', async (req) => {
    const { slug } = req.params as { slug: string };
    const list = await one<any>('select * from lists where slug = $1 and form_enabled', [slug]);
    if (!list) throw notFound('구독 폼을 찾을 수 없습니다.');
    const b = (req.body ?? {}) as Record<string, any>;
    const limited = throttleSubscribe(clientIp(req), normalizeEmail(typeof b.email === 'string' ? b.email : ''));
    if (!limited.ok) {
      throw new HttpError(429, 'rate_limited', '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
    }
    // 구독폼과 같은 규칙: 이미 있는 구독자는 바꾸지 않고, 바꿀 내용은 확인 토큰에 싣는다.
    const agreed = b.ad_agreed ?? b.adAgreed;
    const { needsConfirm, changes, ...outcome } = await publicSubscribe(list, {
      email: typeof b.email === 'string' ? b.email : '',
      fields: b.fields,
      adAgreed: agreed === undefined ? undefined : agreed === true || agreed === 'true' || agreed === 'on',
    });
    const confirmSent = Boolean(needsConfirm && outcome.id && outcome.result !== 'skipped');
    if (confirmSent) await sendConfirmEmail(list.id, outcome.id!, outcome.email, changes);
    return { ok: outcome.result !== 'skipped', confirmSent, ...outcome };
  });
}

async function subscriberFromToken(token: string, kind: 'u' | 'p') {
  const payload = verifyPayload(token);
  if (!payload || !payload.startsWith(kind)) return null;
  const id = payload.slice(1);
  const row = await one<any>(
    `select s.*, l.name as list_name from subscribers s join lists l on l.id = s.list_id where s.id = $1`,
    [id]
  );
  if (!row) return null;
  const { signPayload } = await import('../lib/crypto.js');
  return { ...row, unsubToken: signPayload(`u${row.id}`) };
}

async function recordOpen(token: string, ua: string | undefined, ip: string | null) {
  const payload = verifyPayload(token);
  if (!payload) return;
  const recipientId = parseRecipientToken(payload);
  if (!recipientId) return;

  const r = await one<{ campaign_id: string; subscriber_id: string | null; opened_at: Date | null }>(
    'select campaign_id, subscriber_id, opened_at from campaign_recipients where id = $1',
    [recipientId]
  );
  if (!r) return;

  const info = parseUserAgent(ua);
  await query(
    `insert into events (campaign_id, recipient_id, subscriber_id, type, user_agent, ip, device, os, client)
     values ($1,$2,$3,'open',$4,$5,$6,$7,$8)`,
    [r.campaign_id, recipientId, r.subscriber_id, ua ?? null, ip, info.device, info.os, info.client]
  );
  await query(
    `update campaign_recipients
        set open_count = open_count + 1, opened_at = coalesce(opened_at, now())
      where id = $1`,
    [recipientId]
  );
  await query(
    `update campaigns
        set open_count = open_count + 1,
            unique_open_count = unique_open_count + $2
      where id = $1`,
    [r.campaign_id, r.opened_at ? 0 : 1]
  );
}

async function recordClick(
  token: string,
  linkId: number,
  campaignId: string,
  ua: string | undefined,
  ip: string | null
) {
  const payload = verifyPayload(token);
  if (!payload) return;
  const recipientId = parseRecipientToken(payload);
  if (!recipientId) return;

  const r = await one<{ subscriber_id: string | null; clicked_at: Date | null; opened_at: Date | null }>(
    'select subscriber_id, clicked_at, opened_at from campaign_recipients where id = $1',
    [recipientId]
  );
  if (!r) return;

  // 링크별 순 클릭은 링크 단위로 세야 한다. 캠페인 첫 클릭(clicked_at)으로 세면
  // 같은 사람이 두 번째 링크를 눌렀을 때 그 링크의 순 클릭이 안 오른다.
  const seen = await one<{ x: number }>(
    `select 1 as x from events where link_id = $1 and recipient_id = $2 and type = 'click' limit 1`,
    [linkId, recipientId]
  );

  const info = parseUserAgent(ua);
  await query(
    `insert into events (campaign_id, recipient_id, subscriber_id, link_id, type, user_agent, ip, device, os, client)
     values ($1,$2,$3,$4,'click',$5,$6,$7,$8,$9)`,
    [campaignId, recipientId, r.subscriber_id, linkId, ua ?? null, ip, info.device, info.os, info.client]
  );
  await query(
    `update campaign_recipients
        set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now()),
            opened_at = coalesce(opened_at, now())
      where id = $1`,
    [recipientId]
  );
  await query(
    `update campaign_links
        set click_count = click_count + 1, unique_click_count = unique_click_count + $2
      where id = $1`,
    [linkId, seen ? 0 : 1]
  );
  // 이미지 차단 환경에서는 클릭이 유일한 오픈 신호다.
  await query(
    `update campaigns
        set click_count = click_count + 1,
            unique_click_count = unique_click_count + $2,
            unique_open_count = unique_open_count + $3
      where id = $1`,
    [campaignId, r.clicked_at ? 0 : 1, r.opened_at ? 0 : 1]
  );
}

function clientIp(req: any): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.ip ?? null;
}
