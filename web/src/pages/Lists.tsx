import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api';
import { Empty, Modal } from '../components/ui';

export default function Lists() {
  const [lists, setLists] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<any | null>(null);

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
              <th></th>
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
                <td className="right nowrap">
                  <button className="btn sm danger" onClick={() => setDeleting(l)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!lists.length ? (
              <tr>
                <td colSpan={6}>
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
      {deleting ? (
        <DeleteListModal
          list={deleting}
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

/**
 * 주소록 삭제는 구독자·그룹·세그먼트가 전부 같이 사라진다. 12,000명짜리를 실수로
 * 지우면 복구할 방법이 없으므로 이름을 직접 입력하게 한다.
 */
function DeleteListModal({ list, onClose, onDone }: { list: any; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const total = (list.subscriber_count ?? 0) + (list.unsubscribed_count ?? 0);

  return (
    <Modal title="주소록 삭제" onClose={onClose}>
      <div className="error-box">
        <b>{list.name}</b> 주소록과 구독자 <b>{fmtNum(total)}명</b>, 그룹·세그먼트·구독 폼이 모두 삭제됩니다.
        되돌릴 수 없습니다.
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        이 주소록으로 보낸 이메일의 발송 기록은 남지만, 수신자와의 연결은 끊깁니다.
        발송 중이거나 예약된 이메일이 있으면 삭제되지 않습니다.
      </div>
      <label className="field">
        <span>
          확인을 위해 <b>{list.name}</b> 을(를) 입력하세요
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={list.name} />
      </label>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button
          className="btn danger"
          disabled={typed.trim() !== list.name || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/api/lists/${list.id}`, { method: 'DELETE' });
              onDone();
            } catch (err: any) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          영구 삭제
        </button>
      </div>
    </Modal>
  );
}
