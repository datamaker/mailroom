import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum } from '../api';
import { Badge, Empty, Modal } from '../components/ui';

type Tab = 'dashboard' | 'subscribers' | 'segments' | 'groups' | 'fields' | 'form';

const TABS: Array<[Tab, string]> = [
  ['dashboard', '대시보드'],
  ['subscribers', '구독자 목록'],
  ['segments', '세그먼트'],
  ['groups', '그룹'],
  ['fields', '사용자 정의 필드'],
  ['form', '구독 화면'],
];

export default function ListDetail() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('dashboard');

  const load = () => api(`/api/lists/${id}`).then(setData);
  useEffect(() => {
    load();
  }, [id]);

  if (!data) return <div className="empty">불러오는 중…</div>;
  const { list, stats } = data;

  return (
    <>
      <div className="toolbar">
        <Link to="/lists" className="btn sm">
          ← 주소록
        </Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>{list.name}</h1>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)} style={{ cursor: 'pointer' }}>
            {label}
          </a>
        ))}
      </div>

      {tab === 'dashboard' ? <DashboardTab list={list} stats={stats} onSaved={load} /> : null}
      {tab === 'subscribers' ? <SubscribersTab listId={id!} /> : null}
      {tab === 'segments' ? <SegmentsTab listId={id!} /> : null}
      {tab === 'groups' ? <GroupsTab listId={id!} /> : null}
      {tab === 'fields' ? <FieldsTab listId={id!} /> : null}
      {tab === 'form' ? <FormTab list={list} onSaved={load} /> : null}
    </>
  );
}

function DashboardTab({ list, stats, onSaved }: { list: any; stats: any; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>주소록 정보</h2>
        <button className="btn sm" onClick={() => setEditing(true)}>
          수정하기
        </button>
      </div>
      <div className="panel">
        <div className="row">
          <div>
            <div className="faint">기본 발신자</div>
            <div>
              {list.default_sender_name ?? '-'} &lt;{list.default_sender_email ?? '-'}&gt;
            </div>
            <div className="faint" style={{ marginTop: 12 }}>
              구독 확인 이메일
            </div>
            <div>{list.double_optin ? '사용' : '사용 안 함'}</div>
          </div>
          <div>
            <div className="faint">이메일 푸터 정보</div>
            <div>{list.footer_company ?? '-'}</div>
            <div>{list.footer_address ?? '-'}</div>
            <div>{list.footer_phone ?? '-'}</div>
          </div>
        </div>
      </div>

      <h2>현황</h2>
      <div className="cards">
        <div className="card">
          <div className="label">구독 중</div>
          <div className="value">{fmtNum(stats.subscribed)}</div>
        </div>
        <div className="card">
          <div className="label">수신거부</div>
          <div className="value">{fmtNum(stats.unsubscribed)}</div>
        </div>
        <div className="card">
          <div className="label">자동삭제</div>
          <div className="value">{fmtNum(stats.deleted)}</div>
        </div>
        <div className="card">
          <div className="label">확인 대기</div>
          <div className="value">{fmtNum(stats.pending)}</div>
        </div>
      </div>

      {editing ? (
        <EditListModal
          list={list}
          onClose={() => {
            setEditing(false);
            onSaved();
          }}
        />
      ) : null}
    </>
  );
}

function EditListModal({ list, onClose }: { list: any; onClose: () => void }) {
  const [form, setForm] = useState({ ...list });
  const set = (k: string, v: any) => setForm({ ...form, [k]: v });
  return (
    <Modal title="주소록 수정" onClose={onClose}>
      <label className="field">
        <span>주소록 이름</span>
        <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="row">
        <label className="field">
          <span>기본 발신자 이름</span>
          <input value={form.default_sender_name ?? ''} onChange={(e) => set('default_sender_name', e.target.value)} />
        </label>
        <label className="field">
          <span>기본 발신자 이메일</span>
          <input value={form.default_sender_email ?? ''} onChange={(e) => set('default_sender_email', e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>푸터 회사명</span>
        <input value={form.footer_company ?? ''} onChange={(e) => set('footer_company', e.target.value)} />
      </label>
      <label className="field">
        <span>푸터 주소</span>
        <input value={form.footer_address ?? ''} onChange={(e) => set('footer_address', e.target.value)} />
      </label>
      <label className="field">
        <span>푸터 전화번호</span>
        <input value={form.footer_phone ?? ''} onChange={(e) => set('footer_phone', e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={!!form.double_optin} onChange={(e) => set('double_optin', e.target.checked)} />
        구독 확인 이메일 사용
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={!!form.auto_delete_hard_bounce}
          onChange={(e) => set('auto_delete_hard_bounce', e.target.checked)}
        />
        하드바운스 구독자 자동삭제
      </label>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            await api(`/api/lists/${list.id}`, {
              method: 'PATCH',
              body: {
                name: form.name,
                default_sender_name: form.default_sender_name,
                default_sender_email: form.default_sender_email,
                footer_company: form.footer_company,
                footer_address: form.footer_address,
                footer_phone: form.footer_phone,
                double_optin: form.double_optin,
                auto_delete_hard_bounce: form.auto_delete_hard_bounce,
              },
            });
            onClose();
          }}
        >
          저장하기
        </button>
      </div>
    </Modal>
  );
}

function SubscribersTab({ listId }: { listId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [fields, setFields] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('subscribed');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = () =>
    api(`/api/lists/${listId}/subscribers`, { query: { q, status, limit: 100 } }).then((r: any) => {
      setRows(r.subscribers);
      setTotal(r.total);
    });

  useEffect(() => {
    api(`/api/lists/${listId}/fields`).then((r: any) => setFields(r.fields));
  }, [listId]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [listId, q, status]);

  const shown = fields.filter((f) => f.key !== 'email').slice(0, 4);

  return (
    <>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="subscribed">구독 중</option>
          <option value="unsubscribed">수신거부</option>
          <option value="deleted">자동삭제</option>
          <option value="pending">확인 대기</option>
          <option value="all">전체</option>
        </select>
        <input placeholder="이메일·이름·회사 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="faint">{fmtNum(total)}명</span>
        <div className="spacer" />
        <a className="btn sm" href={`/api/lists/${listId}/subscribers/export?status=${status}`}>
          내보내기
        </a>
        <button className="btn sm" onClick={() => setImporting(true)}>
          CSV 가져오기
        </button>
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          구독자 추가하기
        </button>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이메일 주소</th>
              <th>상태</th>
              {shown.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th>그룹</th>
              <th>구독일</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.email}</td>
                <td>
                  <Badge status={s.status} />
                </td>
                {shown.map((f) => (
                  <td key={f.key} className="muted">
                    {String(s.fields?.[f.key] ?? '')}
                  </td>
                ))}
                <td className="faint">{(s.groups ?? []).map((g: any) => g.name).join(', ')}</td>
                <td className="faint">{fmtDate(s.subscribed_at, false)}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={4 + shown.length}>
                  <Empty>구독자가 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {adding ? (
        <AddSubscriberModal
          listId={listId}
          fields={fields}
          onClose={() => {
            setAdding(false);
            load();
          }}
        />
      ) : null}
      {importing ? (
        <ImportModal
          listId={listId}
          onClose={() => {
            setImporting(false);
            load();
          }}
        />
      ) : null}
    </>
  );
}

function AddSubscriberModal({ listId, fields, onClose }: { listId: string; fields: any[]; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [adAgreed, setAdAgreed] = useState(false);
  const [result, setResult] = useState<string>('');

  return (
    <Modal title="구독자 추가하기" onClose={onClose}>
      {fields.map((f) => (
        <label className="field" key={f.key}>
          <span>
            {f.label} {f.required ? '*' : ''}
          </span>
          <input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
        </label>
      ))}
      <label className="check">
        <input type="checkbox" checked={adAgreed} onChange={(e) => setAdAgreed(e.target.checked)} />
        광고성 정보 수신 동의
      </label>
      {result ? <div className="ok-box">{result}</div> : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          닫기
        </button>
        <button
          className="btn primary"
          disabled={!values.email}
          onClick={async () => {
            const { email, ...rest } = values;
            const r: any = await api(`/api/lists/${listId}/subscribers`, {
              method: 'POST',
              body: { subscribers: [{ email, ...rest, ad_agreed: adAgreed }] },
            });
            setResult(`추가 ${r.created} · 갱신 ${r.updated} · 건너뜀 ${r.skipped}`);
            setValues({});
          }}
        >
          추가하기
        </button>
      </div>
    </Modal>
  );
}

function ImportModal({ listId, onClose }: { listId: string; onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="CSV로 구독자 가져오기" onClose={onClose} wide>
      <div className="hint" style={{ marginBottom: 10 }}>
        첫 줄은 헤더입니다. 필드 이름(이메일 주소, 이름, 회사…) 또는 key를 씁니다.
      </div>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) file.text().then(setCsv);
        }}
      />
      <label className="field" style={{ marginTop: 12 }}>
        <span>또는 직접 붙여넣기</span>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} style={{ minHeight: 160 }} />
      </label>
      {result ? (
        <div className={result.skipped ? 'warn-box' : 'ok-box'}>
          추가 {result.created} · 갱신 {result.updated} · 건너뜀 {result.skipped}
          {result.errors?.slice(0, 5).map((e: any) => (
            <div key={e.email} className="faint">
              {e.email}: {e.reason}
            </div>
          ))}
        </div>
      ) : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          닫기
        </button>
        <button
          className="btn primary"
          disabled={!csv || busy}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await api(`/api/lists/${listId}/subscribers/import`, { method: 'POST', body: { csv } }));
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

function GroupsTab({ listId }: { listId: string }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState('');
  const load = () => api(`/api/lists/${listId}/groups`).then((r: any) => setGroups(r.groups));
  useEffect(() => {
    load();
  }, [listId]);

  return (
    <>
      <div className="toolbar">
        <input placeholder="새 그룹 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn sm"
          disabled={!name}
          onClick={async () => {
            await api(`/api/lists/${listId}/groups`, { method: 'POST', body: { name } });
            setName('');
            load();
          }}
        >
          그룹 추가
        </button>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>그룹</th>
              <th className="num">구독자</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td className="num">{fmtNum(g.subscriber_count)}</td>
                <td className="right">
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await api(`/api/lists/${listId}/groups/${g.id}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!groups.length ? (
              <tr>
                <td colSpan={3}>
                  <Empty>그룹이 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FieldsTab({ listId }: { listId: string }) {
  const [fields, setFields] = useState<any[]>([]);
  const [form, setForm] = useState({ key: '', label: '', type: 'text', default_value: '' });
  const load = () => api(`/api/lists/${listId}/fields`).then((r: any) => setFields(r.fields));
  useEffect(() => {
    load();
  }, [listId]);

  return (
    <>
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <table className="data">
          <thead>
            <tr>
              <th>필드 이름</th>
              <th>키</th>
              <th>메일머지 기본값</th>
              <th>유형</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id}>
                <td>{f.label}</td>
                <td className="mono">{f.key}</td>
                <td className="muted">{f.default_value ?? ''}</td>
                <td className="muted">{f.type}</td>
                <td className="right">
                  {f.is_system ? (
                    <span className="faint">기본</span>
                  ) : (
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        await api(`/api/lists/${listId}/fields/${f.id}`, { method: 'DELETE' });
                        load();
                      }}
                    >
                      삭제
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>필드 추가하기</h3>
        <div className="row">
          <label className="field">
            <span>필드 이름</span>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label className="field">
            <span>키 (영문)</span>
            <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="company" />
          </label>
          <label className="field">
            <span>메일머지 기본값</span>
            <input value={form.default_value} onChange={(e) => setForm({ ...form, default_value: e.target.value })} />
          </label>
        </div>
        <button
          className="btn primary"
          disabled={!form.key || !form.label}
          onClick={async () => {
            await api(`/api/lists/${listId}/fields`, { method: 'POST', body: form });
            setForm({ key: '', label: '', type: 'text', default_value: '' });
            load();
          }}
        >
          추가하기
        </button>
        <div className="hint">추가한 키는 이메일에서 $%{'{'}키{'}'}%$ 형태로… 예: $%company%$</div>
      </div>
    </>
  );
}

function SegmentsTab({ listId }: { listId: string }) {
  const [segments, setSegments] = useState<any[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);

  const load = () => api(`/api/lists/${listId}/segments`).then((r: any) => setSegments(r.segments));
  useEffect(() => {
    load();
    api(`/api/lists/${listId}/fields`).then((r: any) => setFields(r.fields));
  }, [listId]);

  return (
    <>
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn primary sm" onClick={() => setEditing({ name: '', match: 'all', conditions: [] })}>
          + 세그먼트 만들기
        </button>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이름</th>
              <th>조건</th>
              <th className="num">대상</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="faint">
                  {s.match === 'all' ? '모두 만족' : '하나라도 만족'} · {s.conditions.length}개
                </td>
                <td className="num">{fmtNum(s.subscriber_count)}</td>
                <td className="right nowrap">
                  <button className="btn sm" onClick={() => setEditing(s)}>
                    수정
                  </button>{' '}
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await api(`/api/lists/${listId}/segments/${s.id}`, { method: 'DELETE' });
                      load();
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!segments.length ? (
              <tr>
                <td colSpan={4}>
                  <Empty>세그먼트가 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <SegmentModal
          listId={listId}
          fields={fields}
          segment={editing}
          onClose={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}

const OPS: Array<[string, string]> = [
  ['eq', '같음'],
  ['neq', '같지 않음'],
  ['contains', '포함'],
  ['not_contains', '포함하지 않음'],
  ['starts_with', '~로 시작'],
  ['ends_with', '~로 끝남'],
  ['is_empty', '비어 있음'],
  ['is_not_empty', '비어 있지 않음'],
];

function SegmentModal({
  listId,
  fields,
  segment,
  onClose,
}: {
  listId: string;
  fields: any[];
  segment: any;
  onClose: () => void;
}) {
  const [name, setName] = useState(segment.name ?? '');
  const [match, setMatch] = useState(segment.match ?? 'all');
  const [conditions, setConditions] = useState<any[]>(segment.conditions ?? []);
  const [count, setCount] = useState<number | null>(null);

  const preview = async () => {
    const r: any = await api(`/api/lists/${listId}/subscribers`, {
      query: { filter: JSON.stringify({ match, conditions }), limit: 1 },
    });
    setCount(r.total);
  };

  return (
    <Modal title="세그먼트" onClose={onClose} wide>
      <label className="field">
        <span>이름</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>조건 결합</span>
        <select value={match} onChange={(e) => setMatch(e.target.value)}>
          <option value="all">모든 조건을 만족</option>
          <option value="any">하나라도 만족</option>
        </select>
      </label>

      {conditions.map((c, i) => (
        <div className="row" key={i} style={{ alignItems: 'flex-end', marginBottom: 8 }}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>필드</span>
            <select
              value={c.key ?? 'email'}
              onChange={(e) => {
                const next = [...conditions];
                next[i] = { ...c, type: 'field', key: e.target.value };
                setConditions(next);
              }}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>조건</span>
            <select
              value={c.op ?? 'contains'}
              onChange={(e) => {
                const next = [...conditions];
                next[i] = { ...c, op: e.target.value };
                setConditions(next);
              }}
            >
              {OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>값</span>
            <input
              value={c.value ?? ''}
              onChange={(e) => {
                const next = [...conditions];
                next[i] = { ...c, value: e.target.value };
                setConditions(next);
              }}
            />
          </label>
          <button className="btn sm danger" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>
            삭제
          </button>
        </div>
      ))}

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button
          className="btn sm"
          onClick={() => setConditions([...conditions, { type: 'field', key: 'email', op: 'contains', value: '' }])}
        >
          + 조건 추가
        </button>
        <button className="btn sm" onClick={preview}>
          대상 미리보기
        </button>
        {count !== null ? <span className="faint">{fmtNum(count)}명</span> : null}
      </div>

      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button
          className="btn primary"
          disabled={!name}
          onClick={async () => {
            if (segment.id) {
              await api(`/api/lists/${listId}/segments/${segment.id}`, {
                method: 'PATCH',
                body: { name, match, conditions },
              });
            } else {
              await api(`/api/lists/${listId}/segments`, { method: 'POST', body: { name, match, conditions } });
            }
            onClose();
          }}
        >
          저장하기
        </button>
      </div>
    </Modal>
  );
}

function FormTab({ list, onSaved }: { list: any; onSaved: () => void }) {
  const [form, setForm] = useState({
    form_enabled: list.form_enabled,
    form_title: list.form_title ?? '',
    form_description: list.form_description ?? '',
    double_optin: list.double_optin,
  });
  const url = `${window.location.origin}/s/${list.slug}`;

  return (
    <div className="panel" style={{ maxWidth: 600 }}>
      <h3 style={{ marginTop: 0 }}>구독 폼</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={form.form_enabled}
          onChange={(e) => setForm({ ...form, form_enabled: e.target.checked })}
        />
        구독 폼으로 구독 신청받기
      </label>
      <label className="field">
        <span>제목</span>
        <input value={form.form_title} onChange={(e) => setForm({ ...form, form_title: e.target.value })} />
      </label>
      <label className="field">
        <span>설명</span>
        <textarea
          value={form.form_description}
          onChange={(e) => setForm({ ...form, form_description: e.target.value })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.double_optin}
          onChange={(e) => setForm({ ...form, double_optin: e.target.checked })}
        />
        구독 확인 이메일 발송하기
      </label>

      <div className="field">
        <span style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>구독 폼 주소</span>
        <a href={url} target="_blank" rel="noreferrer" className="mono">
          {url}
        </a>
      </div>

      <div className="field">
        <span style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>외부 사이트에서 직접 붙일 때</span>
        <pre className="mono" style={{ background: 'var(--bg-sunken)', padding: 12, borderRadius: 6, overflow: 'auto' }}>
{`POST ${window.location.origin}/api/public/lists/${list.slug}/subscribe
{"email":"...","fields":{"name":"..."},"ad_agreed":true}`}
        </pre>
      </div>

      <button
        className="btn primary"
        onClick={async () => {
          await api(`/api/lists/${list.id}`, { method: 'PATCH', body: form });
          onSaved();
        }}
      >
        저장하기
      </button>
    </div>
  );
}
