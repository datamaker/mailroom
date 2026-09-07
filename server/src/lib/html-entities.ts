/**
 * href 속성 값은 HTML 이라 `&` 가 `&amp;` 로 인코딩돼 들어온다.
 * URL 로 다루기 전에 반드시 풀고, 다시 속성에 넣을 땐 다시 감싸야 한다.
 * 이걸 안 하면 추적 링크가 `amp;utm_medium=` 같은 쓰레기 파라미터로 리다이렉트된다.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    return NAMED[body.toLowerCase()] ?? full;
  });
}

/** URL 을 href 속성에 다시 넣을 때 쓴다. */
export function encodeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
