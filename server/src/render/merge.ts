/**
 * 메일머지. 스티비와 같은 `$%key%$` 문법을 쓴다 — 기존 콘텐츠를 그대로 옮길 수 있다.
 * 값이 없으면 사용자 정의 필드의 "메일머지 기본값"으로 떨어지고, 그것도 없으면 빈 문자열.
 */

const TAG = /\$%\s*([a-zA-Z0-9_.\-]+)\s*%\$/g;

export interface MergeSource {
  /** 구독자 필드 (email, name, company, ...) */
  fields: Record<string, unknown>;
  /** 사용자 정의 필드의 기본값 */
  defaults?: Record<string, string | null | undefined>;
  /** 링크류 특수 태그 */
  links?: {
    unsubscribe?: string;
    preferences?: string;
    webview?: string;
  };
}

export function mergeTags(input: string, src: MergeSource): string {
  if (!input) return input;
  return input.replace(TAG, (_full, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === 'unsubscribe') return src.links?.unsubscribe ?? '';
    if (key === 'preferences') return src.links?.preferences ?? '';
    // 스티비는 웹에서 보기를 permalink 라고 부른다 — 가져온 콘텐츠가 그대로 동작하도록.
    if (key === 'webview' || key === 'permalink') return src.links?.webview ?? '';

    const direct = src.fields[rawKey] ?? src.fields[key];
    if (direct !== undefined && direct !== null && String(direct) !== '') return String(direct);

    const fallback = src.defaults?.[rawKey] ?? src.defaults?.[key];
    return fallback ? String(fallback) : '';
  });
}

/** 콘텐츠에서 쓰인 머지태그 목록 (에디터에서 "미치환 태그" 경고에 쓴다) */
export function usedTags(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(TAG)) out.add(m[1]);
  return [...out];
}

export const SPECIAL_TAGS = ['unsubscribe', 'preferences', 'webview', 'permalink'];
