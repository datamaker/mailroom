/**
 * 발송 링크에 UTM 을 붙인다.
 *
 * 본문에 손으로 적어 둔 UTM 이 서비스 이름째로 굳어 버리는 걸 막으려고,
 * source/medium/campaign 은 발송 시점에 플랫폼이 다시 쓴다(mode='overwrite').
 * mode='fill' 이면 비어 있는 값만 채우고 작성자가 적은 값을 남긴다.
 * utm_term·utm_content 와 그 밖의 쿼리 파라미터는 어느 모드에서든 건드리지 않는다.
 */
import { decodeEntities, encodeAttr } from '../lib/html-entities.js';

export interface UtmConfig {
  enabled?: boolean;
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  mode?: 'overwrite' | 'fill';
}

export const UTM_DEFAULTS: UtmConfig = {
  enabled: true,
  source: 'newsletter',
  medium: 'email',
  campaign: '',
  mode: 'overwrite',
};

const KEYS: Array<[keyof UtmConfig, string]> = [
  ['source', 'utm_source'],
  ['medium', 'utm_medium'],
  ['campaign', 'utm_campaign'],
  ['term', 'utm_term'],
  ['content', 'utm_content'],
];

export function tagUrl(raw: string, cfg: UtmConfig): string {
  if (!/^https?:\/\//i.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const overwrite = (cfg.mode ?? 'overwrite') === 'overwrite';
  for (const [field, param] of KEYS) {
    const v = (cfg[field] as string | undefined)?.trim();
    if (!v) continue;
    if (!overwrite && u.searchParams.has(param)) continue;
    u.searchParams.set(param, v);
  }
  return u.toString();
}

/** 우리 링크(추적·수신거부·웹뷰)와 병합 태그가 든 URL 은 건드리지 않는다. */
function skip(url: string, publicUrl: string): boolean {
  if (url.includes('$%')) return true;
  return url.startsWith(`${publicUrl}/`);
}

export function applyUtm(html: string, cfg: UtmConfig, publicUrl: string): string {
  if (!cfg.enabled) return html;
  return html.replace(/href="([^"]+)"/g, (full, raw: string) => {
    const url = decodeEntities(raw);
    if (skip(url, publicUrl)) return full;
    const tagged = tagUrl(url, cfg);
    return tagged === url ? full : `href="${encodeAttr(tagged)}"`;
  });
}
