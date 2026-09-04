export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, any> } = {}
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? res.statusText);
  return json as T;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function fmtDate(v: string | null | undefined, withTime = true) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function fmtNum(n: number | null | undefined) {
  return (n ?? 0).toLocaleString('ko-KR');
}

export function pct(n: number | null | undefined) {
  return `${n ?? 0}%`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: '작성중',
  scheduled: '예약됨',
  sending: '발송중',
  sent: '발송완료',
  paused: '일시중지',
  failed: '실패',
  canceled: '취소됨',
  subscribed: '구독 중',
  unsubscribed: '수신거부',
  deleted: '자동삭제',
  pending: '확인대기',
};
