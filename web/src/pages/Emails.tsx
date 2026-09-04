import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api';
import { Badge, Empty, Modal, Rate } from '../components/ui';

export default function Emails() {
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [filters, setFilters] = useState({ status: 'all', listId: '', q: '' });
  const [creating, setCreating] = useState(false);
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
  useEffect(load, [filters.status, filters.listId, filters.q]);

  return (
    <>
      <h1>이메일</h1>
      <div className="toolbar">
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
    </>
  );
}

function CreateModal({ lists, onClose }: { lists: any[]; onClose: () => void }) {
  const nav = useNavigate();
  const [subject, setSubject] = useState('');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r: any = await api('/api/campaigns', {
        method: 'POST',
        body: {
          subject,
          list_id: listId || null,
          content: [
            { id: 'webview', type: 'webview' },
            { id: 'text1', type: 'text', html: '<p>여기에 내용을 작성하세요.</p>' },
            { id: 'footer', type: 'footer' },
          ],
        },
      });
      nav(`/emails/${r.campaign.id}/edit`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="일반 이메일 만들기" onClose={onClose}>
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
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button className="btn primary" disabled={!subject || busy} onClick={submit}>
          만들기
        </button>
      </div>
    </Modal>
  );
}
