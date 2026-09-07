import { many, one } from '../db/pool.js';
import { config } from '../config.js';
import { countAudience } from './audience.js';
import { sendLocked } from './provider.js';
import { SPECIAL_TAGS, usedTags } from '../render/merge.js';
import { renderEmailHtml } from '../render/html.js';

/**
 * 발송 전 점검.
 *
 * 3만 명에게 나가는 버튼은 되돌릴 수 없다. 실수하면 손쓸 방법이 없는 것들
 * (깨진 병합 태그, 빠진 수신거부 링크, 죽은 링크)을 누르기 전에 잡는다.
 *
 * level:
 *   error — 이대로 보내면 사고다. 발송을 막는다.
 *   warn  — 보낼 수는 있지만 확인하는 게 좋다.
 *   info  — 참고.
 */
export type Level = 'error' | 'warn' | 'info';

export interface Check {
  id: string;
  level: Level;
  title: string;
  detail?: string;
}

export interface Preflight {
  count: number;
  checks: Check[];
  canSend: boolean;
  linksChecked: boolean;
}

/** 구독자에게 기본으로 붙어 있는 값들 — 사용자 정의 필드가 아니어도 쓸 수 있다. */
const BUILTIN_TAGS = ['email', 'name', 'id'];

export async function preflight(c: any, opts: { links?: boolean } = {}): Promise<Preflight> {
  const checks: Check[] = [];
  const add = (level: Level, id: string, title: string, detail?: string) =>
    checks.push({ id, level, title, detail });

  if (!c.list_id) {
    add('error', 'list', '주소록이 선택되지 않았습니다.');
    return { count: 0, checks, canSend: false, linksChecked: false };
  }

  const count = await countAudience(c.list_id, c.target || {});
  const subject = String(c.subject ?? '').trim();
  const content = Array.isArray(c.content) ? c.content : [];
  const serialized = JSON.stringify(content);

  // ---- 이대로 보내면 사고 ----
  if (!subject) add('error', 'subject', '제목이 비어 있습니다.');
  if (!content.length) add('error', 'content', '콘텐츠가 비어 있습니다.');
  if (count === 0) add('error', 'audience', '발송 대상이 0명입니다.');

  if (!c.sender_email) {
    add('error', 'sender', '발신자 이메일 주소가 없습니다.');
  } else {
    const sender = await one<{ verified: boolean }>(
      'select verified from senders where lower(email) = lower($1)',
      [c.sender_email]
    );
    if (!sender?.verified) {
      add('error', 'sender-verified', `발신자 ${c.sender_email} 이(가) 인증되지 않았습니다.`, 'SPF·DKIM·DMARC 를 확인하세요. 설정 > 발신자 관리.');
    }
  }

  // 푸터 상자가 없어도 본문에 $%unsubscribe%$ 가 있으면 된다.
  if (!serialized.includes('unsubscribe') && !serialized.includes('"footer"')) {
    add('error', 'unsubscribe', '수신거부 링크가 없습니다.', '푸터 상자를 넣거나 본문에 $%unsubscribe%$ 를 쓰세요. 법으로 요구됩니다.');
  }

  // 오타 난 병합 태그는 구독자에게 빈칸으로 나간다 — "안녕하세요 님" 사고.
  const fields = await many<{ key: string }>('select key from custom_fields where list_id = $1', [c.list_id]);
  const known = new Set([...fields.map((f) => f.key), ...BUILTIN_TAGS, ...SPECIAL_TAGS]);
  const unknown = [...new Set([...usedTags(serialized), ...usedTags(subject)])].filter((t) => !known.has(t));
  if (unknown.length) {
    add(
      'error',
      'merge-tags',
      `주소록에 없는 병합 태그 ${unknown.length}개`,
      `${unknown.map((t) => `$%${t}%$`).join(', ')} — 구독자에게 빈칸으로 나갑니다.`
    );
  }

  if (sendLocked()) {
    add(
      'error',
      'send-lock',
      '발송 잠금이 켜져 있습니다.',
      config.send.allowedRecipients.length ? `허용: ${config.send.allowedRecipients.join(', ')}` : undefined
    );
  }

  // ---- 확인하는 게 좋다 ----
  if (c.is_ad && !/^\(광고/.test(subject)) {
    add('warn', 'ad-prefix', '광고 메일이라 제목 앞에 (광고)가 자동으로 붙습니다.');
  }
  if (subject.length > 60) {
    add('warn', 'subject-length', `제목이 ${subject.length}자입니다.`, '받은편지함에서 뒷부분이 잘립니다. 40자 안쪽을 권합니다.');
  }
  if (!String(c.preheader ?? '').trim()) {
    add('warn', 'preheader', '미리보기 텍스트가 비어 있습니다.', '받은편지함에서 제목 옆에 본문 첫 줄이 그대로 노출됩니다.');
  }

  const html = safeRender(c);
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt\s*=\s*"[^"]+"/i.test(t));
  if (noAlt.length) {
    add('warn', 'img-alt', `설명(alt) 없는 이미지 ${noAlt.length}개`, '이미지를 막아 둔 사람에게는 빈칸으로 보입니다.');
  }

  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (imgs.length && text.length < 200) {
    add('warn', 'image-heavy', '글보다 이미지가 훨씬 많습니다.', '이미지만 있는 메일은 스팸으로 분류되기 쉽습니다.');
  }

  const links = uniqueLinks(html);
  if (!links.length && content.length) {
    add('info', 'no-links', '본문에 링크가 없습니다.', '클릭 통계가 잡히지 않습니다.');
  }

  let linksChecked = false;
  if (opts.links && links.length) {
    linksChecked = true;
    const dead = await checkLinks(links);
    if (dead.length) {
      add(
        'warn',
        'dead-links',
        `열리지 않는 링크 ${dead.length}개`,
        dead.map((d) => `${d.url} (${d.reason})`).join('\n')
      );
    }
  }

  return { count, checks, canSend: !checks.some((k) => k.level === 'error'), linksChecked };
}

function safeRender(c: any): string {
  try {
    return renderEmailHtml(c.content ?? [], { styles: c.styles, mode: 'email' });
  } catch {
    return '';
  }
}

function uniqueLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(url)) continue;
    if (url.includes('$%')) continue; // 병합 태그가 든 주소는 아직 완성 전이다
    if (url.startsWith(`${config.publicUrl}/`)) continue;
    out.add(url);
  }
  return [...out];
}

/** 링크가 실제로 열리는지 본다. 오래 붙잡고 있으면 화면이 멈추므로 짧게 끊는다. */
async function checkLinks(urls: string[]): Promise<Array<{ url: string; reason: string }>> {
  const dead: Array<{ url: string; reason: string }> = [];
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const reason = await probe(url);
      if (reason) dead.push({ url, reason });
    }
  });
  await Promise.all(workers);
  return dead;
}

async function probe(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    // HEAD 를 막아 둔 서버가 많아 안 되면 GET 으로 한 번 더 본다.
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal });
    }
    // 403 은 봇을 막는 것뿐인 경우가 흔해 죽었다고 단정하지 않는다.
    if (res.status >= 400 && res.status !== 403 && res.status !== 429) return `HTTP ${res.status}`;
    return null;
  } catch (e: any) {
    return e.name === 'AbortError' ? '응답 없음' : '연결 실패';
  } finally {
    clearTimeout(timer);
  }
}
