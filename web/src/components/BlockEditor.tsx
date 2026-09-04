import { useRef, useState } from 'react';
import { api } from '../api';

export const BLOCK_LABELS: Record<string, string> = {
  webview: '웹에서 보기',
  text: '텍스트',
  image: '이미지',
  button: '버튼',
  row: '1단 가로',
  columns: '2단',
  divider: '구분선',
  social: 'SNS 링크',
  video: '동영상',
  product: '상품',
  html: 'HTML 코드',
  footer: '푸터',
  spacer: '공백',
};

let seq = 0;
export function newBlock(type: string) {
  const id = `b${Date.now().toString(36)}${seq++}`;
  switch (type) {
    case 'text':
      return { id, type, html: '<p>내용을 입력하세요.</p>' };
    case 'image':
      return { id, type, src: '', alt: '', align: 'center' };
    case 'button':
      return { id, type, text: '확인하기', href: 'https://', align: 'center' };
    case 'row':
      return { id, type, imageSrc: '', html: '<p>설명</p>', imagePosition: 'left', imageWidth: 240 };
    case 'columns':
      return { id, type, columns: [{ html: '<p>왼쪽</p>' }, { html: '<p>오른쪽</p>' }] };
    case 'social':
      return { id, type, items: [{ network: '홈페이지', url: 'https://' }] };
    case 'video':
      return { id, type, thumbnail: '', href: 'https://', title: '' };
    case 'product':
      return { id, type, name: '상품명', price: '', href: 'https://', buttonText: '구매하기' };
    case 'html':
      return { id, type, html: '<!-- HTML -->' };
    case 'spacer':
      return { id, type, height: 24 };
    default:
      return { id, type };
  }
}

/** 이미지 주소 입력칸 + 파일 업로드. 외부 URL 을 그대로 쓸 수도 있다. */
function ImageField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/assets', { method: 'POST', body: form, credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? '업로드에 실패했습니다.');
      onChange(json.asset.url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input value={value ?? ''} placeholder="https://… 또는 파일 올리기" onChange={(e) => onChange(e.target.value)} />
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '올리는 중…' : '파일 올리기'}
        </button>
        {value ? (
          <img
            src={value}
            alt=""
            style={{ height: 30, borderRadius: 4, border: '1px solid var(--border)' }}
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      {error ? <div className="hint" style={{ color: 'var(--red)' }}>{error}</div> : null}
      <div className="hint">5MB 이하 · PNG · JPEG · GIF · WebP · SVG</div>
    </label>
  );
}

interface Props {
  blocks: any[];
  styles: Record<string, any>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (blocks: any[]) => void;
  onStyles: (styles: Record<string, any>) => void;
}

export function BlockEditor({ blocks, styles, selected, onSelect, onChange, onStyles }: Props) {
  const [tab, setTab] = useState<'blocks' | 'styles'>('blocks');
  const current = blocks.find((b) => b.id === selected);

  const update = (id: string, patch: Record<string, any>) =>
    onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const move = (index: number, delta: number) => {
    const next = [...blocks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const add = (type: string) => {
    const block = newBlock(type);
    const at = selected ? blocks.findIndex((b) => b.id === selected) + 1 : blocks.length;
    const next = [...blocks];
    next.splice(at, 0, block);
    onChange(next);
    onSelect(block.id);
  };

  return (
    <>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <a className={tab === 'blocks' ? 'active' : ''} onClick={() => setTab('blocks')} style={{ cursor: 'pointer' }}>
          상자
        </a>
        <a className={tab === 'styles' ? 'active' : ''} onClick={() => setTab('styles')} style={{ cursor: 'pointer' }}>
          스타일
        </a>
      </div>

      {tab === 'styles' ? (
        <StyleEditor styles={styles} onChange={onStyles} />
      ) : (
        <>
          <div className="block-list">
            {blocks.map((b, i) => (
              <div
                key={b.id}
                className={`block-item${b.id === selected ? ' active' : ''}`}
                onClick={() => onSelect(b.id === selected ? null : b.id)}
              >
                <span className="type">{BLOCK_LABELS[b.type] ?? b.type}</span>
                <span className="preview">{summarize(b)}</span>
                <span className="ctl" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => move(i, -1)} title="위로">
                    ↑
                  </button>
                  <button onClick={() => move(i, 1)} title="아래로">
                    ↓
                  </button>
                  <button
                    onClick={() => {
                      onChange(blocks.filter((x) => x.id !== b.id));
                      if (selected === b.id) onSelect(null);
                    }}
                    title="삭제"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>

          {current ? (
            <div className="panel" style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>{BLOCK_LABELS[current.type] ?? current.type} 설정</h3>
              <BlockFields block={current} onChange={(patch) => update(current.id, patch)} />
            </div>
          ) : null}

          <h3>상자 추가</h3>
          <div className="palette">
            {Object.entries(BLOCK_LABELS).map(([type, label]) => (
              <button key={type} onClick={() => add(type)}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function summarize(b: any) {
  if (b.type === 'text' || b.type === 'html') return stripTags(b.html ?? '').slice(0, 30);
  if (b.type === 'image') return b.src ? b.src.split('/').pop() : '(이미지 없음)';
  if (b.type === 'button') return b.text;
  if (b.type === 'product') return b.name;
  if (b.type === 'spacer') return `${b.height ?? 24}px`;
  return '';
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function BlockFields({ block, onChange }: { block: any; onChange: (patch: Record<string, any>) => void }) {
  const text = (key: string, label: string, placeholder = '') => (
    <label className="field">
      <span>{label}</span>
      <input value={block[key] ?? ''} placeholder={placeholder} onChange={(e) => onChange({ [key]: e.target.value })} />
    </label>
  );
  const area = (key: string, label: string) => (
    <label className="field">
      <span>{label}</span>
      <textarea value={block[key] ?? ''} onChange={(e) => onChange({ [key]: e.target.value })} />
      <div className="hint">HTML을 그대로 씁니다. $%name%$ 같은 메일머지 태그도 됩니다.</div>
    </label>
  );
  const align = () => (
    <label className="field">
      <span>정렬</span>
      <select value={block.align ?? 'center'} onChange={(e) => onChange({ align: e.target.value })}>
        <option value="left">왼쪽</option>
        <option value="center">가운데</option>
        <option value="right">오른쪽</option>
      </select>
    </label>
  );

  switch (block.type) {
    case 'text':
      return area('html', '내용');
    case 'html':
      return area('html', 'HTML');
    case 'image':
      return (
        <>
          <ImageField label="이미지" value={block.src} onChange={(src) => onChange({ src })} />
          {text('alt', '대체 텍스트')}
          {text('href', '클릭 시 이동할 주소')}
          {align()}
        </>
      );
    case 'button':
      return (
        <>
          {text('text', '버튼 문구')}
          {text('href', '링크')}
          {text('color', '배경색 (예: #e8543f)')}
          {align()}
        </>
      );
    case 'row':
      return (
        <>
          <ImageField label="이미지" value={block.imageSrc} onChange={(imageSrc) => onChange({ imageSrc })} />
          {text('imageHref', '이미지 링크')}
          <label className="field">
            <span>이미지 위치</span>
            <select value={block.imagePosition ?? 'left'} onChange={(e) => onChange({ imagePosition: e.target.value })}>
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
            </select>
          </label>
          {area('html', '텍스트')}
        </>
      );
    case 'columns':
      return (
        <>
          {(block.columns ?? []).map((col: any, i: number) => (
            <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <ImageField
                label={`${i + 1}번째 칸 이미지`}
                value={col.imageSrc ?? ''}
                onChange={(imageSrc) => {
                  const cols = [...block.columns];
                  cols[i] = { ...col, imageSrc };
                  onChange({ columns: cols });
                }}
              />
              <label className="field">
                <span>{i + 1}번째 칸 텍스트</span>
                <textarea
                  value={col.html ?? ''}
                  onChange={(e) => {
                    const cols = [...block.columns];
                    cols[i] = { ...col, html: e.target.value };
                    onChange({ columns: cols });
                  }}
                />
              </label>
            </div>
          ))}
          <button
            className="btn sm"
            onClick={() => onChange({ columns: [...(block.columns ?? []), { html: '<p>새 칸</p>' }] })}
          >
            칸 추가
          </button>
        </>
      );
    case 'social':
      return (
        <>
          {(block.items ?? []).map((item: any, i: number) => (
            <div className="row" key={i}>
              <label className="field">
                <span>이름</span>
                <input
                  value={item.network}
                  onChange={(e) => {
                    const items = [...block.items];
                    items[i] = { ...item, network: e.target.value };
                    onChange({ items });
                  }}
                />
              </label>
              <label className="field">
                <span>링크</span>
                <input
                  value={item.url}
                  onChange={(e) => {
                    const items = [...block.items];
                    items[i] = { ...item, url: e.target.value };
                    onChange({ items });
                  }}
                />
              </label>
            </div>
          ))}
          <button className="btn sm" onClick={() => onChange({ items: [...(block.items ?? []), { network: '', url: '' }] })}>
            링크 추가
          </button>
        </>
      );
    case 'video':
      return (
        <>
          <ImageField label="썸네일" value={block.thumbnail} onChange={(thumbnail) => onChange({ thumbnail })} />
          {text('href', '영상 링크')}
          {text('title', '제목')}
        </>
      );
    case 'product':
      return (
        <>
          <ImageField label="상품 이미지" value={block.imageSrc} onChange={(imageSrc) => onChange({ imageSrc })} />
          {text('name', '상품명')}
          {text('price', '가격')}
          {text('href', '상품 링크')}
          {text('buttonText', '버튼 문구')}
        </>
      );
    case 'divider':
      return (
        <>
          {text('color', '색상')}
          <label className="field">
            <span>두께</span>
            <input
              type="number"
              value={block.thickness ?? 1}
              onChange={(e) => onChange({ thickness: Number(e.target.value) })}
            />
          </label>
        </>
      );
    case 'spacer':
      return (
        <label className="field">
          <span>높이 (px)</span>
          <input type="number" value={block.height ?? 24} onChange={(e) => onChange({ height: Number(e.target.value) })} />
        </label>
      );
    case 'footer':
      return (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>
            비워 두면 주소록에 설정된 푸터 정보를 씁니다.
          </div>
          {text('company', '회사명')}
          {text('address', '주소')}
          {text('phone', '전화번호')}
        </>
      );
    case 'webview':
      return text('text', '문구');
    default:
      return <div className="faint">설정할 항목이 없습니다.</div>;
  }
}

function StyleEditor({ styles, onChange }: { styles: Record<string, any>; onChange: (s: Record<string, any>) => void }) {
  const field = (key: string, label: string, type = 'text') => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={styles[key] ?? ''}
        onChange={(e) => onChange({ ...styles, [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
      />
    </label>
  );
  return (
    <>
      {field('bodyBackground', '전체 배경 색상')}
      {field('contentBackground', '본문 배경 색상')}
      {field('contentWidth', '본문 너비 (px)', 'number')}
      {field('fontSize', '기본 글자 크기 (px)', 'number')}
      {field('textColor', '글자 색상')}
      {field('linkColor', '링크 색상')}
      {field('buttonColor', '버튼 배경 색상')}
      {field('buttonTextColor', '버튼 글자 색상')}
    </>
  );
}
