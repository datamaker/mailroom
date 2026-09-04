import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Empty, Modal } from '../components/ui';

export default function Templates() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [preview, setPreview] = useState<any | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api('/api/templates')
      .then((r: any) => setTemplates(r.templates))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>템플릿</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setImporting(true)}>
          HTML 가져오기
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 16 }}>
        이메일을 만들 때 고를 수 있는 서식입니다. 스티비에서 <b>HTML 내보내기(이메일 발송용)</b>로 받은 파일을
        올리면 상자 단위로 되살려 그대로 편집할 수 있습니다.
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이름</th>
              <th className="num">상자</th>
              <th>마지막 수정</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.name}</strong>
                  {t.is_builtin ? <span className="tag" style={{ marginLeft: 6 }}>기본</span> : null}
                </td>
                <td className="num muted">{t.block_count ?? '-'}</td>
                <td className="faint">{fmtDate(t.updated_at)}</td>
                <td className="right nowrap">
                  <Link className="btn sm primary" to={`/templates/${t.id}/edit`}>
                    편집
                  </Link>{' '}
                  <button className="btn sm" onClick={() => setPreview(t)}>
                    미리보기
                  </button>{' '}

                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!confirm(`"${t.name}" 템플릿을 삭제할까요?`)) return;
                      await api(`/api/templates/${t.id}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!templates.length && !loading ? (
              <tr>
                <td colSpan={4}>
                  <Empty>템플릿이 없습니다. 스티비에서 받은 HTML을 올려보세요.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {preview ? <PreviewModal template={preview} onClose={() => setPreview(null)} /> : null}
      {importing ? (
        <ImportModal
          onClose={() => {
            setImporting(false);
            load();
          }}
        />
      ) : null}
    </>
  );
}

export function PreviewModal({ template, onClose }: { template: any; onClose: () => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    api(`/api/templates/${template.id}/html`).then((r: any) => setHtml(r.html));
  }, [template.id]);
  return (
    <Modal title={template.name} onClose={onClose} wide>
      <iframe
        srcDoc={html}
        title="미리보기"
        style={{ width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 6 }}
      />
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [html, setHtml] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="HTML로 템플릿 만들기" onClose={onClose} wide>
      <label className="field">
        <span>템플릿 이름</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="바이오위클리 주간 템플릿" />
      </label>
      <label className="field">
        <span>HTML 파일</span>
        <input
          type="file"
          accept=".html,text/html"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              f.text().then(setHtml);
              if (!name) setName(f.name.replace(/\.html?$/i, ''));
            }
          }}
        />
        <div className="hint">
          스티비 &gt; 이메일 &gt; HTML 내보내기 &gt; <b>이메일 발송용</b>으로 받은 파일을 그대로 올리면 됩니다.
        </div>
      </label>
      {html ? <div className="faint">{html.length.toLocaleString()}자 읽음</div> : null}
      {result ? (
        <div className="ok-box">
          상자 {result.blocks}개 인식 · 이미지 {result.images}개
          {result.rawCount ? ` · 그대로 남긴 상자 ${result.rawCount}개` : ''}
        </div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          닫기
        </button>
        <button
          className="btn primary"
          disabled={!html || !name || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const r: any = await api('/api/templates/import', { method: 'POST', body: { html, name } });
              setResult(r.stats);
            } catch (err: any) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          가져오기
        </button>
      </div>
    </Modal>
  );
}
