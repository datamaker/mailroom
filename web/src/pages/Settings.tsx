import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Empty, Modal } from '../components/ui';

type Tab = 'senders' | 'keys' | 'users' | 'suppressions';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('senders');
  return (
    <>
      <h1>설정</h1>
      <div className="tabs">
        {(
          [
            ['senders', '발신자 관리'],
            ['keys', 'API 키'],
            ['users', '사용자 관리'],
            ['suppressions', '수신 차단'],
          ] as Array<[Tab, string]>
        ).map(([k, l]) => (
          <a key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)} style={{ cursor: 'pointer' }}>
            {l}
          </a>
        ))}
      </div>
      {tab === 'senders' ? <Senders /> : null}
      {tab === 'keys' ? <Keys /> : null}
      {tab === 'users' ? <Users /> : null}
      {tab === 'suppressions' ? <Suppressions /> : null}
    </>
  );
}

function Check({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <span className="faint">-</span>;
  return <span style={{ color: v ? 'var(--green)' : 'var(--red)' }}>{v ? '✓' : '✕'}</span>;
}

function Senders() {
  const [senders, setSenders] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const load = () => api('/api/senders').then((r: any) => setSenders(r.senders));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="hint" style={{ marginBottom: 14 }}>
        이메일을 안정적으로 보내려면 직접 소유한 도메인의 주소를 쓰고 SPF·DKIM·DMARC를 설정하세요.
        발송은 AWS SES를 거치므로 SES에서도 해당 도메인이 인증돼 있어야 합니다.
      </div>
      <div className="toolbar">
        <input placeholder="이메일 주소" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn sm"
          disabled={!email}
          onClick={async () => {
            await api('/api/senders', { method: 'POST', body: { email, name } });
            setEmail('');
            setName('');
            load();
          }}
        >
          발신자 추가
        </button>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이메일 주소</th>
              <th>상태</th>
              <th className="num">SPF</th>
              <th className="num">DKIM</th>
              <th className="num">DMARC</th>
              <th>확인 시각</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {senders.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.email} <span className="faint">{s.name}</span>
                </td>
                <td>{s.verified ? <span className="badge sent">인증됨</span> : <span className="badge draft">미인증</span>}</td>
                <td className="num">
                  <Check v={s.spf} />
                </td>
                <td className="num">
                  <Check v={s.dkim} />
                </td>
                <td className="num">
                  <Check v={s.dmarc} />
                </td>
                <td className="faint">{fmtDate(s.checked_at)}</td>
                <td className="right nowrap">
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await api(`/api/senders/${s.id}/verify`, { method: 'POST' });
                      load();
                    }}
                  >
                    새로고침
                  </button>{' '}
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await api(`/api/senders/${s.id}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!senders.length ? (
              <tr>
                <td colSpan={7}>
                  <Empty>발신자 주소가 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Keys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const load = () => api('/api/keys').then((r: any) => setKeys(r.keys));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="hint" style={{ marginBottom: 14 }}>
        API 키로 CLI(<code>mailroom</code>)와 외부 연동이 접속합니다.
      </div>
      <div className="toolbar">
        <input placeholder="키 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn sm"
          disabled={!name}
          onClick={async () => {
            const r: any = await api('/api/keys', { method: 'POST', body: { name } });
            setCreated(r.key.key);
            setName('');
            load();
          }}
        >
          + 새로 만들기
        </button>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이름</th>
              <th>키</th>
              <th>권한</th>
              <th>만든 날짜</th>
              <th>마지막 사용</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="mono">{k.key_prefix}…</td>
                <td className="muted">{(k.scopes ?? []).join(', ')}</td>
                <td className="faint">{fmtDate(k.created_at)}</td>
                <td className="faint">{fmtDate(k.last_used_at)}</td>
                <td className="right">
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await api(`/api/keys/${k.id}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!keys.length ? (
              <tr>
                <td colSpan={6}>
                  <Empty>API 키가 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {created ? (
        <Modal title="API 키가 만들어졌습니다" onClose={() => setCreated(null)}>
          <div className="warn-box">이 값은 지금 한 번만 보입니다. 안전한 곳에 옮겨 두세요.</div>
          <pre className="mono" style={{ background: 'var(--bg-sunken)', padding: 12, borderRadius: 6, overflow: 'auto' }}>
            {created}
          </pre>
          <div className="hint">
            CLI 설정: <code>mailroom login --url {window.location.origin} --key {created.slice(0, 12)}…</code>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn primary" onClick={() => setCreated(null)}>
              확인
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Users() {
  const [users, setUsers] = useState<any[]>([]);
  const load = () => api('/api/users').then((r: any) => setUsers(r.users));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="panel" style={{ padding: 0 }}>
      <table className="data">
        <thead>
          <tr>
            <th>이메일 주소</th>
            <th>권한</th>
            <th>상태</th>
            <th>마지막 로그인</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>
                <select
                  value={u.role}
                  onChange={async (e) => {
                    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } });
                    load();
                  }}
                >
                  <option value="owner">소유자</option>
                  <option value="admin">관리자</option>
                  <option value="member">멤버</option>
                </select>
              </td>
              <td>
                <span className={`badge ${u.is_active ? 'sent' : 'canceled'}`}>{u.is_active ? '활성' : '비활성'}</span>
              </td>
              <td className="faint">{fmtDate(u.last_login_at)}</td>
              <td className="right">
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } });
                    load();
                  }}
                >
                  {u.is_active ? '비활성화' : '활성화'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Suppressions() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api('/api/suppressions').then((r: any) => setRows(r.suppressions));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="hint" style={{ marginBottom: 14 }}>
        하드바운스와 스팸 신고로 차단된 주소입니다. 어떤 이메일도 이 주소로는 나가지 않습니다.
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이메일</th>
              <th>사유</th>
              <th>상세</th>
              <th>차단 시각</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.email}>
                <td>{r.email}</td>
                <td className="muted">{r.reason}</td>
                <td className="faint">{r.detail ?? ''}</td>
                <td className="faint">{fmtDate(r.created_at)}</td>
                <td className="right">
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await api(`/api/suppressions/${encodeURIComponent(r.email)}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    해제
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={5}>
                  <Empty>차단된 주소가 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
