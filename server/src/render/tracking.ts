import { config } from '../config.js';
import { signPayload } from '../lib/crypto.js';

/** 수신자별로 치환되는 자리표시자. 렌더 시점엔 recipient id를 모른다. */
export const RCPT_PLACEHOLDER = '__MR_RCPT__';

export function recipientToken(recipientId: number | string) {
  return signPayload(`r${recipientId}`);
}

export function parseRecipientToken(payload: string): number | null {
  if (!payload.startsWith('r')) return null;
  const n = Number(payload.slice(1));
  return Number.isFinite(n) ? n : null;
}

export function unsubscribeUrl(subscriberId: string) {
  return `${config.publicUrl}/u/${signPayload(`u${subscriberId}`)}`;
}

export function preferencesUrl(subscriberId: string) {
  return `${config.publicUrl}/p/${signPayload(`p${subscriberId}`)}`;
}

export function webviewUrl(slug: string) {
  return `${config.publicUrl}/w/${slug}`;
}

export interface TrackedLink {
  url: string;
  label?: string;
}

/**
 * 렌더된 HTML의 링크를 추적 URL로 바꾸고 오픈 픽셀을 붙인다.
 * 링크 id는 호출자가 campaign_links 에 저장한 뒤 넘겨준다.
 */
export function extractLinks(html: string): TrackedLink[] {
  const links = new Map<string, TrackedLink>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const url = m[1];
    if (!/^https?:\/\//i.test(url)) continue;
    // 수신거부/구독변경/웹뷰는 우리 링크라 클릭 통계에서 뺀다.
    if (url.startsWith(`${config.publicUrl}/u/`)) continue;
    if (url.startsWith(`${config.publicUrl}/p/`)) continue;
    if (url.startsWith(`${config.publicUrl}/w/`)) continue;
    if (url.includes('$%unsubscribe%$') || url.includes('$%preferences%$')) continue;
    if (!links.has(url)) links.set(url, { url });
  }
  return [...links.values()];
}

export function rewriteLinks(html: string, linkIds: Map<string, number>): string {
  return html.replace(/href="([^"]+)"/g, (full, url: string) => {
    const id = linkIds.get(url);
    if (!id) return full;
    return `href="${config.publicUrl}/t/c/${RCPT_PLACEHOLDER}/${id}"`;
  });
}

export function appendOpenPixel(html: string): string {
  const pixel = `<img src="${config.publicUrl}/t/o/${RCPT_PLACEHOLDER}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  if (html.includes('</body>')) return html.replace('</body>', `${pixel}</body>`);
  return html + pixel;
}

export function personalizeTracking(html: string, recipientId: number | string): string {
  return html.split(RCPT_PLACEHOLDER).join(recipientToken(recipientId));
}
