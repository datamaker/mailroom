export type UaInfo = { device: string; os: string; client: string };

/** 통계의 "모바일 vs 데스크톱"을 채울 최소한의 분류. */
export function parseUserAgent(ua: string | undefined): UaInfo {
  const s = (ua || '').toLowerCase();
  if (!s) return { device: 'unknown', os: 'unknown', client: 'other' };

  // Gmail 이미지 프록시는 UA에 기기 정보가 없다 — 별도 항목으로 뺀다.
  if (s.includes('googleimageproxy')) return { device: 'unknown', os: 'unknown', client: 'gmail' };

  let os = 'unknown';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) os = 'ios';
  else if (s.includes('android')) os = 'android';
  else if (s.includes('windows')) os = 'windows';
  else if (s.includes('mac os') || s.includes('macintosh')) os = 'macos';
  else if (s.includes('linux')) os = 'linux';

  const mobile = os === 'ios' || os === 'android' || s.includes('mobile');
  const device = os === 'unknown' ? 'unknown' : mobile ? 'mobile' : 'desktop';

  let client = 'other';
  if (s.includes('outlook') || s.includes('microsoft office')) client = 'outlook';
  else if (s.includes('thunderbird')) client = 'thunderbird';
  else if (s.includes('naver')) client = 'naver';
  else if (s.includes('daum') || s.includes('kakao')) client = 'daum';
  else if (os === 'ios' || os === 'macos') client = 'apple-mail';

  return { device, os, client };
}
