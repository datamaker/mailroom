/**
 * 메모리 기반 슬라이딩 윈도우.
 *
 * 구독 폼은 로그인 없이 열려 있어서, 남의 주소를 잔뜩 밀어 넣으면 우리 서버가
 * 그 주소들로 확인 메일을 뿌리는 꼴이 된다(우리 발송 평판으로 남을 괴롭히는 셈).
 * nginx 의 IP 제한은 초당 단위라 이런 저속 남용은 못 잡는다.
 *
 * 인스턴스가 하나뿐이라 메모리로 충분하다. 여러 대로 늘리면 공유 저장소로 옮겨야 한다.
 */
interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface Limit {
  /** 창 길이(밀리초) */
  windowMs: number;
  /** 창 안에서 허용할 횟수 */
  max: number;
}

export function rateLimit(key: string, limit: Limit): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - limit.windowMs;
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit.max) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + limit.windowMs - now) / 1000)) };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { ok: true, retryAfterSec: 0 };
}

/** 오래된 버킷을 걷어낸다. 안 하면 IP 마다 항목이 영원히 쌓인다. */
export function startRateLimitSweeper(everyMs = 10 * 60_000) {
  const timer = setInterval(() => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [key, b] of buckets) {
      if (!b.hits.some((t) => t > cutoff)) buckets.delete(key);
    }
  }, everyMs);
  timer.unref?.();
}
