import { spawn } from 'node:child_process';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 * CLI 는 시크릿을 안전하게 보관할 수 없는 공개 클라이언트라, 브라우저에서 승인받고
 * 받아 온 id_token 을 mailroom 서버에 넘겨 세션 토큰으로 바꾼다.
 * vault·lookout CLI 와 같은 흐름이다.
 */

interface Discovery {
  device_authorization_endpoint?: string;
  token_endpoint: string;
}

export interface DeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

const SCOPE = 'openid email profile';

export async function discover(issuer: string): Promise<Discovery> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`SSO 설정을 읽지 못했습니다 (HTTP ${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (!doc.device_authorization_endpoint) {
    throw new Error('이 IdP 는 device flow 를 지원하지 않습니다.');
  }
  return doc;
}

export async function startDeviceAuth(d: Discovery, clientId: string): Promise<DeviceAuth> {
  const res = await fetch(d.device_authorization_endpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`장치 인증 시작 실패 (HTTP ${res.status}) ${body.slice(0, 160)}`);
  }
  return (await res.json()) as DeviceAuth;
}

/** 사용자가 브라우저에서 승인할 때까지 폴링한다. */
export async function pollForIdToken(d: Discovery, clientId: string, auth: DeviceAuth): Promise<string> {
  let intervalMs = (auth.interval ?? 5) * 1000;
  const deadline = Date.now() + auth.expires_in * 1000;

  for (;;) {
    if (Date.now() > deadline) throw new Error('승인 대기 시간이 지났습니다. 다시 시도하세요.');
    await sleep(intervalMs);

    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.device_code,
        client_id: clientId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };

    if (res.ok) {
      if (!body.id_token) throw new Error('IdP 응답에 id_token 이 없습니다.');
      return body.id_token;
    }

    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'expired_token':
        throw new Error('승인 전에 코드가 만료됐습니다. 다시 시도하세요.');
      case 'access_denied':
        throw new Error('브라우저에서 로그인이 거부되었습니다.');
      default:
        throw new Error(body.error_description || body.error || `로그인 실패 (HTTP ${res.status})`);
    }
  }
}

/** 브라우저를 열어 준다. 실패해도 조용히 넘어간다 — 주소는 이미 출력했다. */
export function tryOpenBrowser(url: string) {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* 수동으로 열면 된다 */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
