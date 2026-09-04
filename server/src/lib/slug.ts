import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 사람이 읽고 부를 수 있는 짧은 공개 식별자 (l/1, o/0 제외) */
export function shortId(len = 8) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function slugify(input: string, fallbackLen = 6) {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  // 한글만 있는 이름은 URL에 그대로 쓰기 곤란하니 랜덤 접미사로 유일성을 준다.
  const ascii = base.replace(/[^a-z0-9-]/g, '');
  return ascii.length >= 3 ? `${ascii}-${shortId(fallbackLen)}` : shortId(10);
}
