import {
  type Block,
  type EmailStyles,
  type Padding,
  DEFAULT_STYLES,
  PADDING_PX,
} from './blocks.js';

export interface RenderContext {
  styles?: EmailStyles;
  /** 푸터/웹뷰 블록이 채워 넣을 값들 */
  footer?: { company?: string | null; address?: string | null; phone?: string | null };
  /** 머지태그로 남겨두면 발송 시점에 수신자별로 치환된다 */
  webviewUrl?: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  /** 웹 게시용은 픽셀/추적 없이, 이메일용은 있는 그대로 */
  mode?: 'email' | 'web';
}

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(url: string | undefined): string {
  // 머지태그($%...%$)는 통과시키되 스크립트 스킴은 막는다.
  const v = String(url ?? '').trim();
  if (/^\s*javascript:/i.test(v) || /^\s*data:text\/html/i.test(v)) return '#';
  return escapeHtml(v);
}

function pad(p: Padding | undefined, fallback: Padding): number {
  return PADDING_PX[p ?? fallback];
}

function blockShell(b: Block, inner: string, s: Required<EmailStyles>) {
  const pt = pad(b.paddingTop, 'normal');
  const pb = pad(b.paddingBottom, 'normal');
  const px = pad(b.paddingX, 'normal');
  const bg = b.background || 'transparent';
  const border =
    b.borderWidth && b.borderWidth > 0
      ? `border:${b.borderWidth}px solid ${escapeHtml(b.borderColor || s.borderColor)};`
      : '';
  return `<tr><td class="mr-block" style="padding:${pt}px ${px}px ${pb}px ${px}px;background-color:${escapeHtml(
    bg
  )};${border}">${inner}</td></tr>`;
}

function textStyles(s: Required<EmailStyles>) {
  return `font-family:${s.fontFamily};font-size:${s.fontSize}px;line-height:1.7;color:${s.textColor};`;
}

function renderImage(src: string, alt: string, width: number | 'full' | undefined, s: Required<EmailStyles>) {
  const w = width === 'full' || width === undefined ? '100%' : `${width}px`;
  return `<img src="${attr(src)}" alt="${escapeHtml(alt)}" width="${
    width === 'full' || width === undefined ? s.contentWidth : width
  }" style="display:block;border:0;outline:none;text-decoration:none;max-width:100%;width:${w};height:auto;" />`;
}

function renderBlock(b: Block, ctx: RenderContext, s: Required<EmailStyles>): string {
  switch (b.type) {
    case 'text':
      return blockShell(b, `<div class="mr-text" style="${textStyles(s)}">${b.html || ''}</div>`, s);

    case 'image': {
      const img = renderImage(b.src, b.alt || '', b.width, s);
      const wrapped = b.href ? `<a href="${attr(b.href)}" target="_blank">${img}</a>` : img;
      return blockShell(b, `<div style="text-align:${b.align || 'center'};">${wrapped}</div>`, s);
    }

    case 'button': {
      const bg = b.color || s.buttonColor;
      const fg = b.textColor || s.buttonTextColor;
      const radius = b.radius ?? 4;
      const btn =
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" ` +
        `style="${b.fullWidth ? 'width:100%;' : ''}margin:0 ${
          b.align === 'center' ? 'auto' : b.align === 'right' ? '0 0 auto' : '0'
        };">` +
        `<tr><td align="center" bgcolor="${escapeHtml(bg)}" ` +
        `style="border-radius:${radius}px;background-color:${escapeHtml(bg)};padding:14px 28px;">` +
        `<a href="${attr(b.href)}" target="_blank" ` +
        `style="display:inline-block;font-family:${s.fontFamily};font-size:${s.fontSize}px;` +
        `font-weight:600;color:${escapeHtml(fg)};text-decoration:none;">${escapeHtml(b.text)}</a>` +
        `</td></tr></table>`;
      return blockShell(b, `<div style="text-align:${b.align || 'center'};">${btn}</div>`, s);
    }

    case 'divider': {
      const color = b.color || s.borderColor;
      const th = b.thickness ?? 1;
      return blockShell(
        b,
        `<div style="border-top:${th}px ${b.style || 'solid'} ${escapeHtml(color)};font-size:0;line-height:0;">&nbsp;</div>`,
        s
      );
    }

    case 'spacer':
      return `<tr><td style="height:${b.height ?? 24}px;line-height:${b.height ?? 24}px;font-size:0;">&nbsp;</td></tr>`;

    case 'html':
      return blockShell(b, b.html || '', s);

    case 'webview': {
      const url = ctx.webviewUrl || '$%webview%$';
      return blockShell(
        b,
        `<div style="text-align:${b.align || 'left'};font-family:${s.fontFamily};font-size:13px;color:#888888;">` +
          `<a href="${attr(url)}" target="_blank" style="color:#888888;text-decoration:underline;">${escapeHtml(
            b.text || '이 메일이 잘 안보이시나요?'
          )}</a></div>`,
        s
      );
    }

    case 'row': {
      const imgW = b.imageWidth ?? 240;
      const img = b.imageSrc ? renderImage(b.imageSrc, b.imageAlt || '', imgW, s) : '';
      const imgCell = `<td class="mr-col" width="${imgW}" valign="top" style="width:${imgW}px;padding:0 12px 0 0;">${
        b.imageHref ? `<a href="${attr(b.imageHref)}" target="_blank">${img}</a>` : img
      }</td>`;
      const textCell = `<td class="mr-col" valign="top" style="${textStyles(s)}padding:0 0 0 12px;">${b.html || ''}</td>`;
      const cells = b.imagePosition === 'right' ? textCell + imgCell : imgCell + textCell;
      return blockShell(
        b,
        `<table role="presentation" class="mr-row" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>${cells}</tr></table>`,
        s
      );
    }

    case 'columns': {
      const cols = b.columns?.length ? b.columns : [{}, {}];
      const width = Math.floor(100 / cols.length);
      const cells = cols
        .map((c) => {
          const img = c.imageSrc ? renderImage(c.imageSrc, c.imageAlt || '', 'full', s) : '';
          const wrapped = c.imageHref && img ? `<a href="${attr(c.imageHref)}" target="_blank">${img}</a>` : img;
          return `<td class="mr-col" valign="top" width="${width}%" style="width:${width}%;padding:0 8px;${textStyles(
            s
          )}">${wrapped}${c.html || ''}</td>`;
        })
        .join('');
      return blockShell(
        b,
        `<table role="presentation" class="mr-row" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>${cells}</tr></table>`,
        s
      );
    }

    case 'social': {
      const items = (b.items || [])
        .map(
          (i) =>
            `<a href="${attr(i.url)}" target="_blank" style="display:inline-block;margin:0 6px;font-family:${
              s.fontFamily
            };font-size:13px;color:${s.linkColor};text-decoration:none;">${escapeHtml(i.network)}</a>`
        )
        .join('');
      return blockShell(b, `<div style="text-align:${b.align || 'center'};">${items}</div>`, s);
    }

    case 'video': {
      const img = renderImage(b.thumbnail, b.title || 'video', 'full', s);
      return blockShell(
        b,
        `<div style="text-align:center;"><a href="${attr(b.href)}" target="_blank">${img}</a>${
          b.title ? `<div style="${textStyles(s)}margin-top:8px;">${escapeHtml(b.title)}</div>` : ''
        }</div>`,
        s
      );
    }

    case 'product': {
      const img = b.imageSrc ? renderImage(b.imageSrc, b.name, 'full', s) : '';
      return blockShell(
        b,
        `<div style="text-align:center;">${
          b.imageSrc ? `<a href="${attr(b.href)}" target="_blank">${img}</a>` : ''
        }<div style="${textStyles(s)}font-weight:600;margin-top:10px;">${escapeHtml(b.name)}</div>${
          b.price ? `<div style="${textStyles(s)}color:#e8543f;">${escapeHtml(b.price)}</div>` : ''
        }<div style="margin-top:10px;"><a href="${attr(b.href)}" target="_blank" style="display:inline-block;background:${
          s.buttonColor
        };color:${s.buttonTextColor};padding:10px 20px;border-radius:4px;text-decoration:none;font-family:${
          s.fontFamily
        };font-size:14px;">${escapeHtml(b.buttonText || '구매하기')}</a></div></div>`,
        s
      );
    }

    case 'footer': {
      const company = b.company ?? ctx.footer?.company ?? '';
      const address = b.address ?? ctx.footer?.address ?? '';
      const phone = b.phone ?? ctx.footer?.phone ?? '';
      const unsub = ctx.unsubscribeUrl || '$%unsubscribe%$';
      const prefs = ctx.preferencesUrl || '$%preferences%$';
      const links: string[] = [];
      if (b.showUnsubscribe !== false)
        links.push(`<a href="${attr(unsub)}" style="color:#888888;">수신거부</a>`);
      if (b.showPreferences !== false)
        links.push(`<a href="${attr(prefs)}" style="color:#888888;">구독 정보 변경</a>`);
      return blockShell(
        b,
        `<div style="font-family:${s.fontFamily};font-size:12px;line-height:1.8;color:#888888;text-align:center;">` +
          [company, address, phone].filter(Boolean).map(escapeHtml).join('<br />') +
          (links.length ? `<div style="margin-top:10px;">${links.join(' &nbsp;|&nbsp; ')}</div>` : '') +
          `</div>`,
        s
      );
    }

    default:
      return '';
  }
}

/**
 * 블록 배열 → 이메일 클라이언트가 견디는 테이블 기반 HTML.
 * 인라인 스타일 + 640px 고정폭 + 모바일 미디어쿼리라는 흔한 조합을 따른다.
 */
export function renderEmailHtml(blocks: Block[], ctx: RenderContext = {}): string {
  const s = { ...DEFAULT_STYLES, ...(ctx.styles || {}) } as Required<EmailStyles>;
  const body = (blocks || []).map((b) => renderBlock(b, ctx, s)).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${escapeHtml(ctx.footer?.company || '')}</title>
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse !important; }
  a { color:${s.linkColor}; }
  .mr-text p { margin:0 0 12px 0; }
  .mr-text h1,.mr-text h2,.mr-text h3 { margin:0 0 12px 0; line-height:1.35; }
  .mr-text ul,.mr-text ol { margin:0 0 12px 0; padding-left:22px; }
  @media only screen and (max-width:640px) {
    .mr-container { width:100% !important; }
    .mr-row, .mr-col { display:block !important; width:100% !important; max-width:100% !important; box-sizing:border-box; }
    .mr-col { padding:0 0 12px 0 !important; }
    .mr-block { padding-left:16px !important; padding-right:16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${s.bodyBackground};">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:${s.bodyBackground};">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" class="mr-container" border="0" cellpadding="0" cellspacing="0" width="${s.contentWidth}"
             style="width:${s.contentWidth}px;max-width:100%;background-color:${s.contentBackground};${
               s.borderWidth > 0 ? `border:${s.borderWidth}px solid ${s.borderColor};` : ''
             }">
${body}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** 블록에서 사람이 읽을 수 있는 대체 텍스트를 뽑는다(멀티파트 text/plain용). */
export function renderPlainText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case 'text':
      case 'html':
        out.push(stripTags(b.html || ''));
        break;
      case 'row':
        out.push(stripTags(b.html || ''));
        break;
      case 'columns':
        out.push((b.columns || []).map((c) => stripTags(c.html || '')).join('\n'));
        break;
      case 'button':
        out.push(`${b.text}: ${b.href}`);
        break;
      case 'product':
        out.push(`${b.name} ${b.price ?? ''} ${b.href}`);
        break;
      case 'video':
        out.push(`${b.title ?? '영상'}: ${b.href}`);
        break;
      case 'footer':
        out.push('수신거부: $%unsubscribe%$');
        break;
      default:
        break;
    }
  }
  return out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
