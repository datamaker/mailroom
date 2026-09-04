import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// 미설정이면 프로세스마다 랜덤 — 재시작 시 기존 링크가 죽는다(config에서 경고).
const secret = config.secret || randomBytes(32).toString('hex');

export function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function sign(payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);
}

/** `<payload>.<sig>` 형태의 위조 방지 토큰. 추적 픽셀/클릭 링크에 쓴다. */
export function signPayload(payload: string) {
  return `${payload}.${sign(payload)}`;
}

export function verifyPayload(token: string): string | null {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const given = token.slice(idx + 1);
  const expected = sign(payload);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  return payload;
}

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
