import { loadConfig } from './config.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function base() {
  const { url } = loadConfig();
  if (!url) {
    throw new Error('mailroom 주소가 설정되지 않았습니다. `mailroom login --url https://... --key mrk_...` 를 먼저 실행하세요.');
  }
  return url.replace(/\/$/, '');
}

export async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  const { apiKey } = loadConfig();
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      // 본문이 없는데 content-type 을 붙이면 Fastify 가 400 을 낸다.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(apiKey ? { AccessToken: apiKey, authorization: `Bearer ${apiKey}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? text.slice(0, 200));
  }
  return json as T;
}

export async function apiRaw(path: string): Promise<string> {
  const { apiKey } = loadConfig();
  const res = await fetch(base() + path, {
    headers: apiKey ? { AccessToken: apiKey } : {},
  });
  if (!res.ok) throw new ApiError(res.status, 'error', await res.text());
  return res.text();
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
