import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { BlockEditor } from '../components/BlockEditor';

export default function TemplateEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [t, setT] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const dirty = useRef(false);

  useEffect(() => {
    api(`/api/templates/${id}`).then((r: any) => setT(r.template));
  }, [id]);

  const patch = useCallback((fields: Record<string, any>) => {
    setT((prev: any) => ({ ...prev, ...fields }));
    dirty.current = true;
  }, []);

  const save = useCallback(async () => {
    if (!t) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/templates/${t.id}`, {
        method: 'PATCH',
        body: { name: t.name, content: t.content, styles: t.styles },
      });
      dirty.current = false;
      setSavedAt(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [t]);

  // 이메일 에디터와 같이 조용히 자동 저장한다.
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => {
      if (dirty.current) save();
    }, 1500);
    return () => clearTimeout(timer);
  }, [t, save]);

  // 미리보기는 저장 전 내용을 그대로 렌더한다.
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => {
      api('/api/render/preview', { method: 'POST', body: { content: t.content, styles: t.styles } })
        .then((r: any) => setHtml(r.html))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [t && JSON.stringify(t.content), t && JSON.stringify(t.styles)]);

  if (!t) return <div className="empty">불러오는 중…</div>;

  return (
    <>
      <div className="toolbar">
        <Link to="/templates" className="btn sm">
          ← 템플릿
        </Link>
        <input
          value={t.name}
          onChange={(e) => patch({ name: e.target.value })}
          style={{ width: 280, fontWeight: 600 }}
        />
        <div className="spacer" />
        <span className="faint">
          {saving ? '저장 중…' : savedAt ? `저장됨 ${savedAt.toLocaleTimeString('ko-KR')}` : ''}
        </span>
        <button
          className="btn sm"
          onClick={async () => {
            const name = prompt('복사본 이름', `${t.name} 복사본`);
            if (!name) return;
            const r: any = await api('/api/templates', {
              method: 'POST',
              body: { name, content: t.content, styles: t.styles },
            });
            nav(`/templates/${r.template.id}/edit`);
          }}
        >
          복사본 만들기
        </button>
        <button className="btn sm" onClick={save} disabled={saving}>
          저장
        </button>
      </div>

      {error ? <div className="error-box">{error}</div> : null}
      <div className="hint" style={{ marginBottom: 12 }}>
        템플릿을 고쳐도 이미 만든 이메일에는 반영되지 않습니다. 이메일마다 만들 때의 내용을 따로 갖습니다.
      </div>

      <div className="editor">
        <div className="editor-canvas">
          {/* sandbox 없이는 srcDoc 이 부모 오리진에서 실행된다 — 가져온 HTML 에 스크립트가 있으면 세션이 털린다 */}
          <iframe
            className="editor-frame"
            srcDoc={html}
            title="미리보기"
            sandbox=""
            style={{ height: '100%', border: 0 }}
          />
        </div>
        <div className="editor-side">
          <BlockEditor
            blocks={t.content ?? []}
            styles={t.styles ?? {}}
            selected={selected}
            onSelect={setSelected}
            onChange={(content) => patch({ content })}
            onStyles={(styles) => patch({ styles })}
          />
        </div>
      </div>
    </>
  );
}
