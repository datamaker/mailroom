import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api';
import { Badge, Empty, Modal, Rate } from '../components/ui';
import { PreviewModal } from './Templates';

export default function Emails() {
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [filters, setFilters] = useState({ status: 'all', listId: '', q: '', type: '' });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api('/api/campaigns', { query: { ...filters, limit: 50 } })
      .then((r: any) => setRows(r.campaigns))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api('/api/lists').then((r: any) => setLists(r.lists));
  }, []);
  useEffect(load, [filters.status, filters.listId, filters.q, filters.type]);

  return (
    <>
      <h1>이메일</h1>
      <div className="toolbar">
        <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">모든 유형</option>
          <option value="regular">일반 이메일</option>
          <option value="automation">자동 이메일</option>
        </select>
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="all">모든 상태</option>
          <option value="draft">작성중</option>
          <option value="scheduled">예약됨</option>
          <option value="sending">발송중</option>
          <option value="sent">발송완료</option>
        </select>
        <select value={filters.listId} onChange={(e) => setFilters({ ...filters, listId: e.target.value })}>
          <option value="">전체 주소록</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input
          placeholder="제목 검색"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          + 새로 만들기
        </button>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>제목</th>
              <th>상태</th>
              <th>주소록</th>
              <th className="num">발송</th>
              <th className="num">오픈율</th>
              <th className="num">클릭률</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={c.status === 'draft' ? `/emails/${c.id}/edit` : `/emails/${c.id}`}>
                    {c.is_ad ? <span className="faint">(광고) </span> : null}
                    {c.subject || '(제목 없음)'}
                  </Link>
                  <div className="faint">
                    {fmtDate(c.send_finished_at ?? c.scheduled_at ?? c.updated_at)}
                    {(c.tags ?? []).map((t: string) => (
                      <span className="tag" key={t} style={{ marginLeft: 6 }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <Badge status={c.status} />
                </td>
                <td className="muted">{c.list_name ?? '-'}</td>
                <td className="num">{c.sent_count ? fmtNum(c.sent_count) : '-'}</td>
                <td className="num">
                  <Rate part={c.unique_open_count} whole={c.sent_count} />
                </td>
                <td className="num">
                  <Rate part={c.unique_click_count} whole={c.sent_count} />
                </td>
                <td className="right nowrap">
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const r: any = await api(`/api/campaigns/${c.id}/duplicate`, { method: 'POST' });
                      nav(`/emails/${r.campaign.id}/edit`);
                    }}
                  >
                    복사
                  </button>{' '}
                  <button
                    className="btn sm danger"
                    disabled={c.status === 'sending'}
                    title={c.status === 'sending' ? '발송 중에는 삭제할 수 없습니다' : ''}
                    onClick={() => setDeleting(c)}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && !loading ? (
              <tr>
                <td colSpan={7}>
                  <Empty>이메일이 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {creating ? <CreateModal lists={lists} onClose={() => setCreating(false)} /> : null}
      {deleting ? (
        <DeleteCampaignModal
          campaign={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}

const BLANK = [
  { id: 'webview', type: 'webview' },
  { id: 'text1', type: 'text', html: '<p>여기에 내용을 작성하세요.</p>' },
  { id: 'footer', type: 'footer' },
];

function CreateModal({ lists, onClose }: { lists: any[]; onClose: () => void }) {
  const nav = useNavigate();
  const [subject, setSubject] = useState('');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [templateId, setTemplateId] = useState('');
  const [kind, setKind] = useState<'regular' | 'automation'>('regular');
  const [templates, setTemplates] = useState<any[]>([]);
  const [previewing, setPreviewing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/templates').then((r: any) => setTemplates(r.templates));
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const r: any = await api('/api/campaigns', {
        method: 'POST',
        body: { subject, list_id: listId || null, content: templateId ? [] : BLANK },
      });
      if (kind === 'automation') {
        // 조건은 편집 화면에서 고른다. 여기서는 종류만 정해 둔다.
        await api(`/api/campaigns/${r.campaign.id}`, {
          method: 'PATCH',
          body: { type: 'automation', trigger: { type: 'subscribe', delayMinutes: 0 } },
        });
      }
      // 템플릿은 만든 뒤에 입힌다 — 서식과 스타일을 함께 가져오기 위해.
      if (templateId) {
        await api(`/api/campaigns/${r.campaign.id}/apply-template`, {
          method: 'POST',
          body: { templateId },
        });
      }
      nav(`/emails/${r.campaign.id}/edit`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="이메일 만들기" onClose={onClose}>
      <label className="field">
        <span>종류</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="regular">일반 이메일 — 한 번 골라서 한 번 발송</option>
          <option value="automation">자동 이메일 — 조건이 맞을 때마다 한 명씩</option>
        </select>
        <div className="hint">
          {kind === 'automation'
            ? '구독·오픈·클릭 같은 사건에 반응합니다. 조건은 다음 화면에서 정합니다.'
            : '뉴스레터, 공지처럼 여러 구독자에게 한 번에 보내는 이메일입니다.'}
        </div>
      </label>
      <label className="field">
        <span>제목</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="9월 1주차 뉴스레터" />
      </label>
      <label className="field">
        <span>주소록</span>
        <select value={listId} onChange={(e) => setListId(e.target.value)}>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.subscriber_count}명)
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>템플릿</span>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">빈 이메일로 시작</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} (상자 {t.block_count}개)
            </option>
          ))}
        </select>
        {templateId ? (
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={() => setPreviewing(templates.find((t) => t.id === templateId))}
          >
            템플릿 미리보기
          </button>
        ) : (
          <div className="hint">
            템플릿은 <Link to="/templates">템플릿</Link> 화면에서 만들 수 있습니다.
          </div>
        )}
      </label>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button className="btn primary" disabled={!subject || busy} onClick={submit}>
          만들기
        </button>
      </div>
      {previewing ? <PreviewModal template={previewing} onClose={() => setPreviewing(null)} /> : null}
    </Modal>
  );
}

function DeleteCampaignModal({
  campaign,
  onClose,
  onDone,
}: {
  campaign: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sent = campaign.status === 'sent';

  return (
    <Modal title="이메일 삭제" onClose={onClose}>
      <p>
        <strong>{campaign.subject || '(제목 없음)'}</strong> 을(를) 삭제할까요?
      </p>
      {sent ? (
        <div className="warn-box">
          이미 발송한 이메일입니다. 삭제하면 <b>발송 통계와 수신자 기록도 같이 사라집니다.</b>
          {' '}이미 나간 메일의 추적 링크와 수신거부 링크도 동작하지 않게 됩니다.
        </div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
              onDone();
            } catch (err: any) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          삭제하기
        </button>
      </div>
    </Modal>
  );
}
