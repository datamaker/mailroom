import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * 사용자가 준 URL 을 서버가 대신 열어 볼 때 쓰는 안전한 프로브.
 *
 * 링크 점검은 본문에 적힌 아무 주소나 서버에서 요청한다. 그대로 두면 본문에
 * `http://169.254.169.254/…`(클라우드 메타데이터)나 `http://10.x/…`(사내망)를 적어
 * 서버를 내부망 스캐너로 쓸 수 있다(SSRF). 그래서
 *   1) 이름을 먼저 풀어 **모든** 주소가 공인 주소일 때만 요청하고,
 *   2) 검사한 바로 그 주소로 연결하며(재조회 사이에 답을 바꾸는 DNS 리바인딩 차단),
 *   3) 리다이렉트는 직접 따라가면서 홉마다 같은 검사를 반복한다.
 */

/** 16비트 8개로 푼 IPv6. 파싱할 수 없으면 null. */
function parseIpv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  // 끝에 붙은 IPv4 표기(::ffff:1.2.3.4)는 16비트 2개로 바꾼다.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out.length === 8 ? out : null;
}

function parseIpv4(input: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0) return false; // 0.0.0.0/8 "이 네트워크"
  if (a === 10) return false; // 사설
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 127) return false; // 루프백
  if (a === 169 && b === 254) return false; // 링크 로컬 — 클라우드 메타데이터(169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // 사설
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF 프로토콜 할당
  if (a === 192 && b === 0 && c === 2) return false; // 문서용
  if (a === 192 && b === 168) return false; // 사설
  if (a === 198 && (b === 18 || b === 19)) return false; // 벤치마크
  if (a === 198 && b === 51 && c === 100) return false; // 문서용
  if (a === 203 && b === 0 && c === 113) return false; // 문서용
  if (a >= 224) return false; // 멀티캐스트·예약·브로드캐스트
  return true;
}

const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/**
 * 인터넷에서 닿는 공인 주소인가. 사설·루프백·링크 로컬·CGNAT·메타데이터·멀티캐스트는 false.
 * IPv4 를 품은 IPv6(매핑·호환·NAT64·6to4)는 안쪽 IPv4 로 다시 판단한다 —
 * `::ffff:127.0.0.1` 로 루프백 검사를 피해 가지 못하게.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return isPublicIpv4(v4);

  const h = parseIpv6(address);
  if (!h) return false; // 알아볼 수 없으면 막는다

  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return false; // ::
  if (zeros(7) && h[7] === 1) return false; // ::1
  if (zeros(5) && h[5] === 0xffff) return isPublicIpv4(v4Of(h[6], h[7])); // ::ffff:a.b.c.d
  if (zeros(6)) return isPublicIpv4(v4Of(h[6], h[7])); // ::a.b.c.d (구식 호환 표기)
  if (h[0] === 0x64 && h[1] === 0xff9b) return isPublicIpv4(v4Of(h[6], h[7])); // 64:ff9b::/96, /48 NAT64
  if (h[0] === 0x2002) return isPublicIpv4(v4Of(h[1], h[2])); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return false; // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return false; // 문서용
  if ((h[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 유니크 로컬
  if ((h[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 링크 로컬
  if ((h[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 사이트 로컬(폐기)
  if ((h[0] & 0xff00) === 0xff00) return false; // 멀티캐스트
  return true;
}

export interface ProbeResponse {
  status: number;
  location?: string;
}

export interface ProbeDeps {
  /** 호스트 이름을 주소 목록으로 푼다. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** 검사를 통과한 주소(address)로 실제 요청을 보낸다. 본문은 읽지 않는다. */
  request?: (url: URL, method: 'HEAD' | 'GET', address: string, timeoutMs: number) => Promise<ProbeResponse>;
  maxRedirects?: number;
  /** 요청 한 번의 제한 시간 */
  timeoutMs?: number;
  /** 리다이렉트를 다 합친 제한 시간 */
  totalTimeoutMs?: number;
}

export class BlockedAddressError extends Error {}

async function defaultResolve(hostname: string): Promise<string[]> {
  const found = await dns.lookup(hostname, { all: true, verbatim: true });
  return found.map((f) => f.address);
}

/** 이름 풀이를 다시 하지 않고, 검사한 주소로만 연결한다. */
function defaultRequest(url: URL, method: 'HEAD' | 'GET', address: string, timeoutMs: number): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const family = isIP(address);
    const req = lib.request(
      url,
      {
        method,
        timeout: timeoutMs,
        agent: false,
        headers: { 'user-agent': 'mailroom-link-check', accept: '*/*' },
        // 소켓이 이름을 다시 풀지 못하게 한다. Host 헤더·TLS SNI 는 원래 이름 그대로 간다.
        lookup: ((_host: string, opts: any, cb: any) => {
          if (opts?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as any,
      },
      (res) => {
        const loc = res.headers.location;
        resolve({ status: res.statusCode ?? 0, location: Array.isArray(loc) ? loc[0] : loc });
        res.destroy(); // 본문은 필요 없다
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    req.on('error', reject);
    req.end();
  });
}

/** URL 의 호스트가 공인 주소로만 풀리는지 확인하고, 연결할 주소 하나를 돌려준다. */
export async function resolvePublic(url: URL, resolve = defaultResolve): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError('http/https 가 아닌 주소');
  }
  if (url.username || url.password) throw new BlockedAddressError('자격증명이 든 주소');

  // WHATWG URL 은 `2130706433`·`0x7f.1` 같은 변형을 점 표기 IPv4 로 정규화해 준다.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length) throw new Error('주소를 찾을 수 없음');
  // 하나라도 내부 주소면 통째로 거절한다 — 공인 주소와 섞어 내려 주고 재시도를 노리는 수법을 막는다.
  if (!addresses.every(isPublicAddress)) throw new BlockedAddressError('내부 주소');
  return addresses[0];
}

/**
 * 링크가 열리는지 본다. 리다이렉트는 홉마다 주소 검사를 다시 한다.
 * 마지막 응답의 상태 코드를 돌려주고, 내부 주소로 향하면 BlockedAddressError 를 던진다.
 */
export async function probeUrl(rawUrl: string, deps: ProbeDeps = {}): Promise<number> {
  const resolve = deps.resolve ?? defaultResolve;
  const request = deps.request ?? defaultRequest;
  const maxRedirects = deps.maxRedirects ?? 5;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const deadline = Date.now() + (deps.totalTimeoutMs ?? 6000);

  let url = new URL(rawUrl);
  let method: 'HEAD' | 'GET' = 'HEAD';
  for (let hop = 0; ; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw Object.assign(new Error('timeout'), { name: 'AbortError' });

    const address = await resolvePublic(url, resolve);
    let res = await request(url, method, address, Math.min(timeoutMs, left));
    // HEAD 를 막아 둔 서버가 많아 안 되면 GET 으로 한 번 더 본다.
    if (method === 'HEAD' && (res.status === 405 || res.status === 501)) {
      method = 'GET';
      res = await request(url, method, address, Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= maxRedirects) throw new Error('리다이렉트가 너무 많음');
      url = new URL(res.location, url);
      continue;
    }
    return res.status;
  }
}
