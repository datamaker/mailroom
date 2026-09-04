import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api';
import { Empty, Modal } from '../components/ui';

export default function Lists() {
  const [lists, setLists] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);

  const load = () => api('/api/lists').then((r: any) => setLists(r.lists));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>주소록</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          + 새로 만들기
        </button>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이름</th>
              <th className="num">구독자</th>
              <th className="num">수신거부</th>
              <th>구독 폼</th>
              <th>최근 구독자 추가</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/lists/${l.id}`}>
                    <strong>{l.name}</strong>
                  </Link>
                  <div className="faint">생성일 {fmtDate(l.created_at, false)}</div>
                </td>
                <td className="num">{fmtNum(l.subscriber_count)}</td>
                <td className="num muted">{fmtNum(l.unsubscribed_count)}</td>
                <td>
                  <a href={`/s/${l.slug}`} target="_blank" rel="noreferrer" className="mono">
                    /s/{l.slug}
                  </a>
                </td>
                <td className="faint">{fmtDate(l.last_subscriber_at)}</td>
              </tr>
            ))}
            {!lists.length ? (
              <tr>
                <td colSpan={5}>
                  <Empty>주소록이 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {creating ? (
        <CreateModal
          onClose={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}
    </>
  );
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({
    name: '',
    default_sender_name: '',
    default_sender_email: '',
    footer_company: '',
    footer_address: '',
    footer_phone: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });

  return (
    <Modal title="주소록 만들기" onClose={onClose}>
      <label className="field">
        <span>주소록 이름</span>
        <input value={form.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="row">
        <label className="field">
          <span>기본 발신자 이름</span>
          <input value={form.default_sender_name} onChange={(e) => set('default_sender_name', e.target.value)} />
        </label>
        <label className="field">
          <span>기본 발신자 이메일</span>
          <input value={form.default_sender_email} onChange={(e) => set('default_sender_email', e.target.value)} />
        </label>
      </div>
      <h3>이메일 푸터 정보</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        정보통신망법상 광고성 메일에는 회사명·주소·전화번호 표시가 필요합니다.
      </div>
      <label className="field">
        <span>회사명</span>
        <input value={form.footer_company} onChange={(e) => set('footer_company', e.target.value)} />
      </label>
      <label className="field">
        <span>주소</span>
        <input value={form.footer_address} onChange={(e) => set('footer_address', e.target.value)} />
      </label>
      <label className="field">
        <span>전화번호</span>
        <input value={form.footer_phone} onChange={(e) => set('footer_phone', e.target.value)} />
      </label>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button
          className="btn primary"
          disabled={!form.name || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/lists', { method: 'POST', body: form });
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          만들기
        </button>
      </div>
    </Modal>
  );
}
