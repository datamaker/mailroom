import { parse, type HTMLElement } from 'node-html-parser';
import type { Block } from './blocks.js';

/**
 * 기존 뉴스레터 서비스가 내보낸 이메일 HTML → mailroom 블록.
 *
 * 그런 에디터는 보통 상자마다 `.stb-block-outer` 로 감싸고 종류를 클래스로 남긴다.
 * 그 규칙을 그대로 읽어 블록으로 되돌리면, 기존 뉴스레터를 통째로 가져와도
 * 계속 블록 단위로 편집할 수 있다. 알아보지 못한 상자는 원본 HTML 그대로
 * html 블록에 담아 둔다 — 모양이 깨지느니 편집만 불편한 편이 낫다.
 */

let seq = 0;
const nextId = () => `s${(seq++).toString(36)}`;

export interface ImportResult {
  blocks: Block[];
  /** 블록으로 못 바꾸고 원본 HTML 로 남긴 상자 수 */
  rawCount: number;
  images: string[];
}

export function importEmailHtml(html: string): ImportResult {
  seq = 0;
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  const outers = root.querySelectorAll('.stb-block-outer');
  const blocks: Block[] = [];
  const images: string[] = [];
  let rawCount = 0;

  // 상자 단위 마크업이 없으면 통째로 하나의 html 블록으로 둔다.
  if (!outers.length) {
    const body = root.querySelector('body');
    return {
      blocks: [{ id: nextId(), type: 'html', html: (body ?? root).innerHTML } as Block],
      rawCount: 1,
      images: collectImages(root),
    };
  }

  for (const outer of outers) {
    const block = convertBlock(outer, images);
    if (!block) continue;
    if (block.type === 'html') rawCount++;
    blocks.push(block);
  }

  return { blocks, rawCount, images };
}

function convertBlock(outer: HTMLElement, images: string[]): Block | null {
  // 웹에서 보기
  if (outer.querySelector('.stb-permalink')) {
    const a = outer.querySelector('a');
    return { id: nextId(), type: 'webview', text: text(a) || '이 메일이 잘 안보이시나요?' } as Block;
  }

  // SNS 링크
  const sns = outer.querySelector('.stb-cell-wrap-sns');
  if (sns) {
    const items = sns.querySelectorAll('a').map((a) => ({
      network: guessNetwork(a.getAttribute('href') ?? '', a.querySelector('img')?.getAttribute('src') ?? ''),
      url: a.getAttribute('href') ?? '',
    }));
    return { id: nextId(), type: 'social', items, align: 'center' } as Block;
  }

  // 구분선
  if (outer.querySelector('.stb-partition')) {
    const hr = outer.querySelector('.stb-partition');
    return {
      id: nextId(),
      type: 'divider',
      color: styleValue(hr, 'border-top-color') || styleValue(hr, 'border-color') || undefined,
    } as Block;
  }

  const ctas = outer.querySelectorAll('.stb-cta-box');
  const imageBoxes = outer.querySelectorAll('.stb-image-box');
  const textBoxes = outer.querySelectorAll('.stb-text-box');

  // 2단 — 좌우 칸에 버튼이나 텍스트가 하나씩
  const isTwoCol = Boolean(outer.querySelector('.stb-cols-2')) || outer.querySelectorAll('.stb-right-cell').length > 0;

  // 2단은 CTA/이미지/텍스트 판정보다 먼저 본다. 한 칸에 라벨 텍스트와 버튼이 같이
  // 들어 있는 경우(행사정보 + 확인하기)가 흔한데, 버튼만 떼어내면 라벨이 사라진다.
  if (isTwoCol) {
    const cells = outer.querySelectorAll('.stb-left-cell, .stb-right-cell');
    if (cells.length > 1) {
      return {
        id: nextId(),
        type: 'columns',
        columns: cells.map((cell) => {
          for (const src of collectImages(cell)) images.push(src);
          return { html: innerOf(cell) };
        }),
      } as Block;
    }
  }

  if (ctas.length === 1) {
    return buttonBlock(ctas[0]);
  }
  if (ctas.length > 1) {
    return {
      id: nextId(),
      type: 'columns',
      columns: ctas.map((c) => ({ html: c.outerHTML })),
    } as Block;
  }

  if (imageBoxes.length === 1 && !textBoxes.length) {
    const img = imageBoxes[0].querySelector('img');
    const src = img?.getAttribute('src') ?? '';
    if (src) images.push(src);
    const link = imageBoxes[0].querySelector('a');
    return {
      id: nextId(),
      type: 'image',
      src,
      alt: img?.getAttribute('alt') ?? '',
      href: link?.getAttribute('href') || undefined,
      width: 'full',
      align: 'center',
    } as Block;
  }

  if (textBoxes.length) {
    const inner = outer.querySelector('.stb-text-box-inner') ?? textBoxes[0];
    const html = innerOf(inner);
    for (const src of collectImages(inner)) images.push(src);
    return { id: nextId(), type: 'text', html } as Block;
  }

  // 알아보지 못한 상자 — 원본 그대로 보존한다.
  const raw = outer.innerHTML.trim();
  if (!raw) return null;
  return { id: nextId(), type: 'html', html: raw } as Block;
}

function buttonBlock(cta: HTMLElement): Block {
  const a = cta.querySelector('a');
  const td = cta.querySelector('td');
  return {
    id: nextId(),
    type: 'button',
    text: text(a) || '확인하기',
    href: a?.getAttribute('href') ?? '#',
    color: td?.getAttribute('bgcolor') || styleValue(td, 'background-color') || undefined,
    textColor: styleValue(a, 'color') || undefined,
    align: 'center',
  } as Block;
}

/**
 * 상자 안의 실제 내용만 꺼낸다.
 * 그 마크업은 텍스트를 table > tbody > tr > td 로 감싸는데, 그걸 그대로 가져오면
 * 우리 렌더러의 <div> 안에 <tbody> 가 들어가 유효하지 않은 HTML 이 된다(브라우저가
 * 태그를 버리면서 td 에 걸린 스타일도 같이 날아간다). 껍데기를 벗기고 내용만 쓴다.
 */
function innerOf(el: HTMLElement | null): string {
  if (!el) return '';
  let node: HTMLElement = el;
  for (let depth = 0; depth < 6; depth++) {
    const children = node.childNodes.filter(
      (c: any) => c.nodeType === 1 || (c.nodeType === 3 && String(c.rawText ?? '').trim())
    );
    if (children.length !== 1) break;
    const only = children[0] as HTMLElement;
    if (!only.tagName) break;
    if (!['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH'].includes(only.tagName.toUpperCase())) break;
    node = only;
  }
  return node.innerHTML.trim();
}

function text(el: HTMLElement | null) {
  return (el?.text ?? '').replace(/\s+/g, ' ').trim();
}

function styleValue(el: HTMLElement | null, prop: string) {
  const style = el?.getAttribute('style') ?? '';
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
  return m ? m[1].trim() : '';
}

function collectImages(el: HTMLElement) {
  return el.querySelectorAll('img').map((i) => i.getAttribute('src') ?? '').filter(Boolean);
}

function guessNetwork(href: string, iconSrc: string) {
  const s = `${href} ${iconSrc}`.toLowerCase();
  if (s.includes('facebook')) return '페이스북';
  if (s.includes('instagram')) return '인스타그램';
  if (s.includes('twitter') || s.includes('x.com')) return 'X';
  if (s.includes('youtube')) return '유튜브';
  if (s.includes('linkedin')) return '링크드인';
  if (s.includes('blog') || s.includes('naver')) return '블로그';
  if (s.includes('homepage')) return '홈페이지';
  return '링크';
}
