import { createVerify, X509Certificate } from 'node:crypto';

/**
 * AWS SNS 메시지 서명 검증.
 *
 * 웹훅 주소는 인터넷에 열려 있어서, 서명을 보지 않으면 누구나 바운스/스팸신고를
 * 지어내 임의의 구독자를 차단 목록에 넣을 수 있다. SNS 는 모든 HTTP(S) 전달에
 * 서명을 붙이므로(원시 전달 raw message delivery 가 꺼져 있을 때) 그걸 확인한다.
 *
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

/** 서명·형식이 틀린 메시지. 호출자는 403 으로 거절한다. */
export class SnsVerifyError extends Error {}

/** 인증서를 못 가져온 경우(네트워크 등). 메시지 탓이 아니므로 SNS 가 재시도하게 5xx 로 답한다. */
export class SnsCertFetchError extends Error {}

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

/** 인증서(PEM)를 URL 에서 읽어 오는 함수. 테스트에서 갈아 끼운다. */
export type SnsCertLoader = (url: string) => Promise<string>;

/** SNS 엔드포인트 호스트. 인증서와 SubscribeURL 모두 여기서만 받는다. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

function parseSnsUrl(input: unknown): URL | null {
  if (typeof input !== 'string') return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  // user@host 나 다른 포트로 호스트 검사를 비켜 가는 주소는 받지 않는다.
  if (u.username || u.password || u.port) return null;
  if (!SNS_HOST.test(u.hostname)) return null;
  return u;
}

/** 서명 인증서 주소: https + SNS 호스트 + .pem 으로 끝나는 경로. */
export function isSnsCertUrl(input: unknown): input is string {
  const u = parseSnsUrl(input);
  return Boolean(u && u.pathname.endsWith('.pem'));
}

/** 구독 확인 주소: https + SNS 호스트. */
export function isSnsSubscribeUrl(input: unknown): input is string {
  return parseSnsUrl(input) !== null;
}

/**
 * 서명 대상 문자열. 종류마다 들어가는 필드와 순서가 정해져 있고,
 * "이름\n값\n" 을 그대로 이어 붙인다. Subject 는 있을 때만 들어간다.
 */
export function snsStringToSign(msg: SnsMessage): string {
  const keys =
    msg.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let out = '';
  for (const key of keys) {
    const value = (msg as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      if (key === 'Subject') continue;
      throw new SnsVerifyError(`SNS 메시지에 ${key} 가 없습니다.`);
    }
    if (typeof value !== 'string') throw new SnsVerifyError(`SNS 메시지의 ${key} 형식이 잘못됐습니다.`);
    out += `${key}\n${value}\n`;
  }
  return out;
}

const TYPES = new Set(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']);
const ALGORITHMS: Record<string, string> = { '1': 'RSA-SHA1', '2': 'RSA-SHA256' };

/**
 * 서명을 확인하고, 통과하면 타입이 좁혀진 메시지를 돌려준다.
 * 통과하기 전에는 메시지의 어떤 값도 믿지 않는다(SubscribeURL 호출 포함).
 */
export async function verifySnsMessage(raw: unknown, loadCert: SnsCertLoader): Promise<SnsMessage> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SnsVerifyError('SNS 메시지가 아닙니다.');
  const msg = raw as SnsMessage;

  if (typeof msg.Type !== 'string' || !TYPES.has(msg.Type)) throw new SnsVerifyError('알 수 없는 SNS 메시지 종류입니다.');
  const algorithm = ALGORITHMS[String(msg.SignatureVersion)];
  if (!algorithm) throw new SnsVerifyError('지원하지 않는 SignatureVersion 입니다.');
  if (typeof msg.Signature !== 'string' || !msg.Signature) throw new SnsVerifyError('서명이 없습니다.');
  if (!isSnsCertUrl(msg.SigningCertURL)) throw new SnsVerifyError('SigningCertURL 이 SNS 주소가 아닙니다.');

  const stringToSign = snsStringToSign(msg);

  let pem: string;
  try {
    pem = await loadCert(msg.SigningCertURL);
  } catch (err) {
    throw new SnsCertFetchError(`SNS 서명 인증서를 가져오지 못했습니다: ${(err as Error).message}`);
  }

  let ok = false;
  try {
    const cert = new X509Certificate(pem);
    ok = createVerify(algorithm).update(stringToSign, 'utf8').verify(cert.publicKey, msg.Signature, 'base64');
  } catch {
    ok = false;
  }
  if (!ok) throw new SnsVerifyError('SNS 서명이 맞지 않습니다.');
  return msg;
}

// ---- 인증서 캐시 ----
// SNS 는 리전마다 인증서 하나를 오래 쓴다. 이벤트마다 받아 오면 느리고 AWS 에도 부담이다.

const CERT_CACHE_MAX = 16;
const CERT_MAX_BYTES = 64 * 1024;
const certCache = new Map<string, string>();

/** 기본 로더: 검증된 SNS 주소에서만 받고, 제대로 된 인증서만 메모리에 둔다. */
export const fetchSnsCert: SnsCertLoader = async (url) => {
  // 호출자가 이미 확인하지만, 이 함수만 따로 불려도 SNS 밖으로 나가지 않게 한 번 더 본다.
  if (!isSnsCertUrl(url)) throw new Error('SNS 인증서 주소가 아닙니다.');
  const cached = certCache.get(url);
  if (cached) return cached;

  // 리다이렉트를 따라가면 호스트 검사가 무의미해진다.
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const pem = await res.text();
  if (pem.length > CERT_MAX_BYTES) throw new Error('인증서가 너무 큽니다.');
  new X509Certificate(pem); // 인증서가 아니면 여기서 던진다 — 쓰레기를 캐시하지 않는다.

  if (certCache.size >= CERT_CACHE_MAX) {
    const oldest = certCache.keys().next().value;
    if (oldest !== undefined) certCache.delete(oldest);
  }
  certCache.set(url, pem);
  return pem;
};
