/**
 * 마크다운 → 이메일 블록.
 * AI가 뉴스레터를 쓸 때 블록 JSON을 직접 조립하는 것보다 이쪽이 훨씬 쉽다.
 *
 *   # 제목            → 텍스트 상자 (h1)
 *   본문 문단          → 텍스트 상자
 *   - 목록             → 텍스트 상자 (ul)
 *   ![alt](url)       → 이미지 상자
 *   [텍스트](url){.button} → 버튼 상자
 *   ---               → 구분선
 *   <!-- spacer:32 -→ → 공백
 */

export interface Block {
  id: string;
  type: string;
  [key: string]: unknown;
}

let counter = 0;
const nextId = () => `b${++counter}`;

export function markdownToBlocks(md: string): Block[] {
  counter = 0;
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');

  let paragraph: string[] = [];
  let list: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (!text) return;
    blocks.push({ id: nextId(), type: 'text', html: `<p>${inline(text.replace(/\n/g, '<br />'))}</p>` });
  };

  const flushList = () => {
    if (!list.length) return;
    const tag = listOrdered ? 'ol' : 'ul';
    const items = list.map((i) => `<li>${inline(i)}</li>`).join('');
    list = [];
    blocks.push({ id: nextId(), type: 'text', html: `<${tag}>${items}</${tag}>` });
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    const spacer = line.match(/^<!--\s*spacer:(\d+)\s*-->$/);
    if (spacer) {
      flush();
      blocks.push({ id: nextId(), type: 'spacer', height: Number(spacer[1]) });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush();
      blocks.push({ id: nextId(), type: 'divider' });
      continue;
    }

    const button = line.match(/^\[([^\]]+)\]\(([^)]+)\)\{\.button\}$/);
    if (button) {
      flush();
      blocks.push({ id: nextId(), type: 'button', text: button[1], href: button[2], align: 'center' });
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (image) {
      flush();
      blocks.push({ id: nextId(), type: 'image', alt: image[1], src: image[2], href: image[3] || undefined });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 4); // h1 은 메일에서 너무 커서 한 단계 낮춘다
      blocks.push({ id: nextId(), type: 'text', html: `<h${level}>${inline(heading[2])}</h${level}>` });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (listOrdered) flushList();
      listOrdered = false;
      list.push(bullet[1]);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      if (!listOrdered) flushList();
      listOrdered = true;
      list.push(numbered[1]);
      continue;
    }

    if (line.trimStart().startsWith('<')) {
      flush();
      blocks.push({ id: nextId(), type: 'html', html: line });
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flush();

  return blocks;
}

function inline(text: string) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 마크다운 본문 앞뒤로 웹뷰 링크와 푸터를 붙여 완결된 뉴스레터로 만든다. */
export function wrapNewsletter(blocks: Block[], opts: { webview?: boolean; footer?: boolean } = {}) {
  const out: Block[] = [];
  if (opts.webview !== false) out.push({ id: 'webview', type: 'webview' });
  out.push(...blocks);
  if (opts.footer !== false) out.push({ id: 'footer', type: 'footer' });
  return out;
}
