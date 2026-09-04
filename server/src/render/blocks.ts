/**
 * 이메일 콘텐츠 모델. 에디터의 "상자"에 대응하는 블록 배열이며
 * campaigns.content / templates.content 에 jsonb 로 그대로 저장된다.
 */

export type Align = 'left' | 'center' | 'right';
export type Padding = 'none' | 'narrow' | 'normal' | 'wide';

export interface BlockBase {
  id: string;
  type: string;
  /** 상자 단위 배경/여백 — "스타일" 패널에 해당 */
  background?: string;
  paddingTop?: Padding;
  paddingBottom?: Padding;
  paddingX?: Padding;
  borderColor?: string;
  borderWidth?: number;
}

export interface TextBlock extends BlockBase {
  type: 'text';
  /** 리치 에디터가 만든 HTML 조각 (사내 사용자 입력이라 그대로 싣는다) */
  html: string;
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  src: string;
  alt?: string;
  href?: string;
  width?: number | 'full';
  align?: Align;
}

export interface ButtonBlock extends BlockBase {
  type: 'button';
  text: string;
  href: string;
  color?: string;
  textColor?: string;
  radius?: number;
  align?: Align;
  fullWidth?: boolean;
}

export interface DividerBlock extends BlockBase {
  type: 'divider';
  color?: string;
  thickness?: number;
  style?: 'solid' | 'dashed' | 'dotted';
}

export interface SpacerBlock extends BlockBase {
  type: 'spacer';
  height?: number;
}

export interface HtmlBlock extends BlockBase {
  type: 'html';
  html: string;
}

export interface WebviewBlock extends BlockBase {
  type: 'webview';
  text?: string;
  align?: Align;
}

/** 1단 가로: 이미지 + 텍스트를 좌우로 */
export interface RowBlock extends BlockBase {
  type: 'row';
  imageSrc?: string;
  imageHref?: string;
  imageAlt?: string;
  imagePosition?: 'left' | 'right';
  imageWidth?: number;
  html?: string;
}

/** 2단: 각 칸에 이미지 + 텍스트 */
export interface ColumnsBlock extends BlockBase {
  type: 'columns';
  columns: Array<{ imageSrc?: string; imageHref?: string; imageAlt?: string; html?: string }>;
}

export interface SocialLinkBlock extends BlockBase {
  type: 'social';
  align?: Align;
  items: Array<{ network: string; url: string }>;
}

export interface VideoBlock extends BlockBase {
  type: 'video';
  thumbnail: string;
  href: string;
  title?: string;
}

export interface ProductBlock extends BlockBase {
  type: 'product';
  imageSrc?: string;
  name: string;
  price?: string;
  href: string;
  buttonText?: string;
}

export interface FooterBlock extends BlockBase {
  type: 'footer';
  /** 비우면 주소록의 푸터 정보를 쓴다 */
  company?: string;
  address?: string;
  phone?: string;
  showUnsubscribe?: boolean;
  showPreferences?: boolean;
}

export type Block =
  | TextBlock
  | ImageBlock
  | ButtonBlock
  | DividerBlock
  | SpacerBlock
  | HtmlBlock
  | WebviewBlock
  | RowBlock
  | ColumnsBlock
  | SocialLinkBlock
  | VideoBlock
  | ProductBlock
  | FooterBlock;

export interface EmailStyles {
  bodyBackground?: string;
  contentBackground?: string;
  contentWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  linkColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  borderColor?: string;
  borderWidth?: number;
}

export const DEFAULT_STYLES: Required<EmailStyles> = {
  bodyBackground: '#ffffff',
  contentBackground: '#ffffff',
  contentWidth: 640,
  fontFamily:
    "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif",
  fontSize: 16,
  textColor: '#333333',
  linkColor: '#0f62fe',
  buttonColor: '#e8543f',
  buttonTextColor: '#ffffff',
  borderColor: '#e5e7eb',
  borderWidth: 0,
};

export const PADDING_PX: Record<Padding, number> = {
  none: 0,
  narrow: 10,
  normal: 20,
  wide: 40,
};

export const BLOCK_TYPES = [
  'webview',
  'text',
  'image',
  'button',
  'row',
  'columns',
  'divider',
  'social',
  'video',
  'product',
  'html',
  'footer',
  'spacer',
] as const;
