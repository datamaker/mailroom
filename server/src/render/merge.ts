/**
 * 메일머지. `$%key%$` 문법. 흔한 뉴스레터 서비스와 같은 모양이라 기존 콘텐츠를 그대로 옮길 수 있다.
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

/**
 * 치환되는 자리가 어떤 문맥인가.
 *   'html' — HTML 본문. 구독자 값은 HTML 이스케이프한다.
 *   'text' — 제목·플레인텍스트. 이스케이프는 하지 않고 줄바꿈·제어문자를 지운다.
 */
export type MergeContext = 'html' | 'text';

// C0/C1 제어문자와 유니코드 줄·문단 구분자. 제목에 CR/LF 가 들어가면 헤더가 쪼개진다.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function escapeValue(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 구독자 필드 값(과 필드 기본값)을 문맥에 맞게 무해하게 만든다.
 *
 * 필드 값은 구독폼으로 누구나 넣을 수 있다. 그대로 본문에 박으면 `<a href=피싱>` 같은
 * 마크업이 우리 발신 주소로 나가는 메일 안에 들어간다(관리자 미리보기·웹뷰에서도 살아난다).
 */
function safeValue(value: unknown, context: MergeContext): string {
  const flat = String(value).replace(CONTROL, ' ');
  return context === 'html' ? escapeValue(flat) : flat.trim();
}

export function mergeTags(input: string, src: MergeSource, context: MergeContext): string {
  if (!input) return input;
  return input.replace(TAG, (_full, rawKey: string) => {
    const key = rawKey.toLowerCase();
    // 링크류는 서버가 만든 URL 이다(서명 토큰·슬러그) — 구독자 입력이 아니므로 그대로 넣는다.
    // 이스케이프하면 href 안에서 이중 인코딩될 일은 없지만, 텍스트 본문에서는 주소가 깨진다.
    if (key === 'unsubscribe') return src.links?.unsubscribe ?? '';
    if (key === 'preferences') return src.links?.preferences ?? '';
    // 웹에서 보기를 permalink 라고 부르는 서비스가 있다 — 가져온 콘텐츠가 그대로 동작하도록.
    if (key === 'webview' || key === 'permalink') return src.links?.webview ?? '';

    const direct = src.fields[rawKey] ?? src.fields[key];
    if (direct !== undefined && direct !== null && typeof direct !== 'object' && String(direct) !== '') {
      return safeValue(direct, context);
    }

    // 기본값은 운영자가 넣지만 "값"이지 마크업이 아니다 — 같은 규칙으로 다룬다.
    const fallback = src.defaults?.[rawKey] ?? src.defaults?.[key];
    return fallback ? safeValue(fallback, context) : '';
  });
}

/** 콘텐츠에서 쓰인 머지태그 목록 (에디터에서 "미치환 태그" 경고에 쓴다) */
export function usedTags(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(TAG)) out.add(m[1]);
  return [...out];
}

export const SPECIAL_TAGS = ['unsubscribe', 'preferences', 'webview', 'permalink'];
