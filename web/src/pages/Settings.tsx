import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Empty, Modal } from '../components/ui';

type Tab = 'senders' | 'utm' | 'alerts' | 'keys' | 'users' | 'suppressions';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('senders');
  return (
    <>
      <h1>설정</h1>
      <div className="tabs">
        {(
          [
            ['senders', '발신자 관리'],
            ['utm', '링크 추적(UTM)'],
            ['alerts', '알림'],
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
      {tab === 'utm' ? <Utm /> : null}
      {tab === 'alerts' ? <Alerts /> : null}
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

/**
 * 발송할 때 본문 링크에 자동으로 붙일 UTM.
 * 본문에 손으로 적어 둔 값이 남아 통계가 갈라지는 걸 막으려고 기본은 덮어쓰기다.
 */
function Utm() {
  const [f, setF] = useState<any>(null);
  const [example, setExample] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api('/api/settings/utm').then((r: any) => {
      setF(r.utm);
      setExample(r.example);
    });
  }, []);

  const save = async () => {
    const r: any = await api('/api/settings/utm', { method: 'PUT', body: f });
    setF(r.utm);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    api('/api/settings/utm').then((x: any) => setExample(x.example));
  };

  if (!f) return <Empty>불러오는 중…</Empty>;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        발송할 때 본문 링크에 UTM 을 자동으로 붙입니다
      </label>

      <label className="field">
        <span>utm_source</span>
        <input value={f.source ?? ''} onChange={(e) => set('source', e.target.value)} placeholder="newsletter" />
        <div className="hint">유입 출처. 보통 뉴스레터 이름이나 브랜드를 씁니다.</div>
      </label>
      <label className="field">
        <span>utm_medium</span>
        <input value={f.medium ?? ''} onChange={(e) => set('medium', e.target.value)} placeholder="email" />
      </label>
      <label className="field">
        <span>utm_campaign</span>
        <input value={f.campaign ?? ''} onChange={(e) => set('campaign', e.target.value)} placeholder="(비우면 이메일 이름)" />
        <div className="hint">비워 두면 이메일마다 그 이메일의 이름이 들어갑니다.</div>
      </label>
      <label className="field">
        <span>본문에 이미 UTM 이 있으면</span>
        <select value={f.mode ?? 'overwrite'} onChange={(e) => set('mode', e.target.value)}>
          <option value="overwrite">위 설정으로 덮어쓰기 (권장)</option>
          <option value="fill">그대로 두기</option>
        </select>
        <div className="hint">
          utm_term·utm_content 와 그 밖의 파라미터는 어느 쪽이든 건드리지 않습니다.
        </div>
      </label>

      <label className="field">
        <span>미리보기</span>
        <div className="mono" style={{ wordBreak: 'break-all' }}>{decodeURIComponent(example || '')}</div>
      </label>

      <div className="toolbar">
        <button className="btn primary" onClick={save}>저장</button>
        {saved ? <span className="faint">저장했습니다.</span> : null}
      </div>
    </div>
  );
}

/**
 * 발송이 무너졌을 때 알릴 곳.
 *
 * 주소는 서버 환경변수로 둔다 — 화면에서 바꾸게 하면 웹훅 URL 이 곧 발송 권한인데
 * 그게 DB 와 화면에 그대로 노출된다. 여기서는 연결됐는지 보고 눌러서 확인만 한다.
 */
function Alerts() {
  const [s, setS] = useState<any>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/settings').then(setS);
  }, []);

  if (!s) return <Empty>불러오는 중…</Empty>;

  const test = async () => {
    setBusy(true);
    setResult('');
    try {
      await api('/api/settings/alerts/test', { method: 'POST' });
      setResult('보냈습니다. 슬랙 채널을 확인하세요.');
    } catch (e: any) {
      setResult(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      {s.alertsEnabled ? (
        <div className="ok-box">알림 주소가 설정돼 있습니다.</div>
      ) : (
        <div className="warn-box">
          알림 주소가 없습니다 — 발송이 무너져도 화면을 봐야만 알 수 있습니다.
        </div>
      )}

      <h3>무엇을 알리나</h3>
      <ul className="bullets">
        <li>발송 완료 — 성공·실패 수와 실패 원인 상위 3개</li>
        <li>발송 작업 최종 실패 — 재시도가 다 떨어졌을 때</li>
        <li>스팸 신고 0.1% 초과 — SES 가 발송을 조이기 시작하는 선</li>
      </ul>

      <h3>설정하는 법</h3>
      <ol className="bullets">
        <li>
          슬랙에서 <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">앱을 만들고</a>{' '}
          Incoming Webhooks 를 켠 뒤 받을 채널을 고릅니다.
        </li>
        <li>
          나온 주소를 서버 <code>.env</code> 의 <code>MAILROOM_ALERT_WEBHOOK</code> 에 넣습니다.
        </li>
        <li>서버를 다시 올리고 아래 버튼으로 확인합니다.</li>
      </ol>
      <div className="hint">
        주소 자체가 그 채널에 글을 쓸 수 있는 권한이라 화면에서는 바꾸지 않습니다.
      </div>

      <div className="toolbar">
        <button className="btn" onClick={test} disabled={busy || !s.alertsEnabled}>
          {busy ? '보내는 중…' : '테스트 보내기'}
        </button>
        {result ? <span className="faint">{result}</span> : null}
      </div>
    </div>
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
