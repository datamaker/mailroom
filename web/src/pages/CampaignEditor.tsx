import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Modal } from '../components/ui';
import { BlockEditor, newBlock, BLOCK_LABELS } from '../components/BlockEditor';

type Tab = 'settings' | 'content' | 'send';

export default function CampaignEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [c, setC] = useState<any>(null);
  const [lists, setLists] = useState<any[]>([]);
  const [senders, setSenders] = useState<any[]>([]);
  const [tab, setTab] = useState<Tab>('content');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    api(`/api/campaigns/${id}`).then((r: any) => setC(r.campaign));
    api('/api/lists').then((r: any) => setLists(r.lists));
    api('/api/senders').then((r: any) => setSenders(r.senders));
  }, [id]);

  const patch = useCallback((fields: Record<string, any>) => {
    setC((prev: any) => ({ ...prev, ...fields }));
    dirty.current = true;
  }, []);

  const save = useCallback(async () => {
    if (!c) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/campaigns/${c.id}`, {
        method: 'PATCH',
        body: {
          list_id: c.list_id,
          subject: c.subject,
          preheader: c.preheader,
          sender_name: c.sender_name,
          sender_email: c.sender_email,
          reply_to: c.reply_to,
          content: c.content,
          styles: c.styles,
          target: c.target,
          tags: c.tags,
          is_ad: c.is_ad,
          track_opens: c.track_opens,
          track_clicks: c.track_clicks,
          public_visibility: c.public_visibility,
        },
      });
      dirty.current = false;
      setSavedAt(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [c]);

  // 스티비처럼 편집 중에는 조용히 자동 저장한다.
  useEffect(() => {
    if (!c) return;
    const t = setTimeout(() => {
      if (dirty.current) save();
    }, 1500);
    return () => clearTimeout(t);
  }, [c, save]);

  if (!c) return <div className="empty">불러오는 중…</div>;

  return (
    <>
      <div className="toolbar">
        <Link to="/emails" className="btn sm">
          ← 목록
        </Link>
        <strong style={{ fontSize: 16 }}>{c.subject || '(제목 없음)'}</strong>
        <div className="spacer" />
        <span className="faint">
          {saving ? '저장 중…' : savedAt ? `저장됨 ${savedAt.toLocaleTimeString('ko-KR')}` : ''}
        </span>
        <button className="btn sm" onClick={save} disabled={saving}>
          저장
        </button>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      <div className="wizard">
        {(
          [
            ['settings', '발송 정보'],
            ['content', '콘텐츠'],
            ['send', '발송'],
          ] as Array<[Tab, string]>
        ).map(([key, label], i) => (
          <span key={key}>
            {i > 0 ? <span className="sep"> › </span> : null}
            <span className={`step${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </span>
          </span>
        ))}
      </div>

      {tab === 'settings' ? <SettingsTab c={c} lists={lists} senders={senders} patch={patch} /> : null}
      {tab === 'content' ? <ContentTab c={c} patch={patch} /> : null}
      {tab === 'send' ? <SendTab c={c} save={save} onSent={() => nav(`/emails/${c.id}`)} /> : null}
    </>
  );
}

function SettingsTab({
  c,
  lists,
  senders,
  patch,
}: {
  c: any;
  lists: any[];
  senders: any[];
  patch: (f: Record<string, any>) => void;
}) {
  const [groups, setGroups] = useState<any[]>([]);
  const [segments, setSegments] = useState<any[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const target = c.target ?? {};

  useEffect(() => {
    if (!c.list_id) return;
    api(`/api/lists/${c.list_id}/groups`).then((r: any) => setGroups(r.groups));
    api(`/api/lists/${c.list_id}/segments`).then((r: any) => setSegments(r.segments));
  }, [c.list_id]);

  useEffect(() => {
    if (!c.list_id) return;
    api(`/api/lists/${c.list_id}/audience/count`, { method: 'POST', body: target }).then((r: any) =>
      setCount(r.count)
    );
  }, [c.list_id, JSON.stringify(target)]);

  const toggle = (key: 'groupIds' | 'segmentIds', id: string) => {
    const cur: string[] = target[key] ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patch({ target: { ...target, [key]: next.length ? next : undefined } });
  };

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="panel">
        <h3>기본</h3>
        <label className="field">
          <span>제목</span>
          <input value={c.subject ?? ''} onChange={(e) => patch({ subject: e.target.value })} />
          <div className="hint">$%name%$ 같은 메일머지 태그를 쓸 수 있습니다.</div>
        </label>
        <label className="field">
          <span>미리보기 텍스트</span>
          <input value={c.preheader ?? ''} onChange={(e) => patch({ preheader: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={!!c.is_ad} onChange={(e) => patch({ is_ad: e.target.checked })} />
          광고성 이메일 — 제목에 (광고)가 자동으로 붙습니다
        </label>
        <label className="field">
          <span>태그 (쉼표로 구분)</span>
          <input
            value={(c.tags ?? []).join(',')}
            onChange={(e) => patch({ tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </label>

        <h3>발신자</h3>
        <div className="row">
          <label className="field">
            <span>이름</span>
            <input value={c.sender_name ?? ''} onChange={(e) => patch({ sender_name: e.target.value })} />
          </label>
          <label className="field">
            <span>이메일 주소</span>
            <select value={c.sender_email ?? ''} onChange={(e) => patch({ sender_email: e.target.value })}>
              <option value="">선택하세요</option>
              {senders.map((s) => (
                <option key={s.id} value={s.email}>
                  {s.email} {s.verified ? '' : '(미인증)'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>회신 주소</span>
          <input value={c.reply_to ?? ''} onChange={(e) => patch({ reply_to: e.target.value })} />
        </label>

        <h3>추적</h3>
        <label className="check">
          <input type="checkbox" checked={c.track_opens !== false} onChange={(e) => patch({ track_opens: e.target.checked })} />
          오픈 추적
        </label>
        <label className="check">
          <input type="checkbox" checked={c.track_clicks !== false} onChange={(e) => patch({ track_clicks: e.target.checked })} />
          클릭 추적
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={c.public_visibility === 'public'}
            onChange={(e) => patch({ public_visibility: e.target.checked ? 'public' : 'private' })}
          />
          웹에서 보기 링크를 누구나 열 수 있게 공개
        </label>
      </div>

      <div className="panel">
        <h3>주소록</h3>
        <label className="field">
          <select value={c.list_id ?? ''} onChange={(e) => patch({ list_id: e.target.value })}>
            <option value="">선택하세요</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.subscriber_count}명)
              </option>
            ))}
          </select>
        </label>

        {groups.length ? (
          <>
            <h3>그룹으로 좁히기</h3>
            {groups.map((g) => (
              <label className="check" key={g.id}>
                <input
                  type="checkbox"
                  checked={(target.groupIds ?? []).includes(g.id)}
                  onChange={() => toggle('groupIds', g.id)}
                />
                {g.name} <span className="faint">({g.subscriber_count})</span>
              </label>
            ))}
          </>
        ) : null}

        {segments.length ? (
          <>
            <h3>세그먼트로 좁히기</h3>
            {segments.map((s) => (
              <label className="check" key={s.id}>
                <input
                  type="checkbox"
                  checked={(target.segmentIds ?? []).includes(s.id)}
                  onChange={() => toggle('segmentIds', s.id)}
                />
                {s.name} <span className="faint">({s.subscriber_count})</span>
              </label>
            ))}
          </>
        ) : null}

        <label className="check">
          <input
            type="checkbox"
            checked={!!target.adAgreedOnly}
            onChange={(e) => patch({ target: { ...target, adAgreedOnly: e.target.checked || undefined } })}
          />
          광고성 정보 수신 동의자만
        </label>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="label">발송 대상</div>
          <div className="value">{count === null ? '…' : count.toLocaleString('ko-KR')}</div>
        </div>
      </div>
    </div>
  );
}

function ContentTab({ c, patch }: { c: any; patch: (f: Record<string, any>) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const blocks = c.content ?? [];

  useEffect(() => {
    const t = setTimeout(() => {
      api('/api/render/preview', { method: 'POST', body: { content: blocks, styles: c.styles } })
        .then((r: any) => setHtml(r.html))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(blocks), JSON.stringify(c.styles)]);

  return (
    <div className="editor">
      <div className="editor-canvas">
        <iframe className="editor-frame" srcDoc={html} title="미리보기" style={{ height: '100%', border: 0 }} />
      </div>
      <div className="editor-side">
        <BlockEditor
          blocks={blocks}
          styles={c.styles ?? {}}
          selected={selected}
          onSelect={setSelected}
          onChange={(next) => patch({ content: next })}
          onStyles={(styles) => patch({ styles })}
        />
      </div>
    </div>
  );
}

function SendTab({ c, save, onSent }: { c: any; save: () => Promise<void>; onSent: () => void }) {
  const [check, setCheck] = useState<any>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = () => api(`/api/campaigns/${c.id}/audience`).then(setCheck);
  useEffect(() => {
    save().then(refresh);
  }, []);

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await save();
      await api(`/api/campaigns/${c.id}/send`, { method: 'POST' });
      onSent();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      <h3>발송 전 점검</h3>
      {!check ? (
        <div className="faint">확인 중…</div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="label">발송 대상</div>
            <div className="value">{check.count.toLocaleString('ko-KR')}</div>
          </div>
          {check.issues.length ? (
            <div className="warn-box">
              {check.issues.map((i: string) => (
                <div key={i}>· {i}</div>
              ))}
            </div>
          ) : (
            <div className="ok-box">문제 없습니다.</div>
          )}
        </>
      )}

      {error ? <div className="error-box">{error}</div> : null}

      <div className="btn-row">
        <button className="btn" onClick={() => setTestOpen(true)}>
          테스트 발송
        </button>
        <button className="btn dark" onClick={() => setScheduleOpen(true)}>
          예약하기
        </button>
        <button className="btn primary" onClick={send} disabled={busy || !check || check.count === 0}>
          지금 발송하기
        </button>
      </div>

      {testOpen ? <TestModal campaignId={c.id} onClose={() => setTestOpen(false)} /> : null}
      {scheduleOpen ? (
        <ScheduleModal campaignId={c.id} save={save} onClose={() => setScheduleOpen(false)} onDone={onSent} />
      ) : null}
    </div>
  );
}

function TestModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [emails, setEmails] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      const r: any = await api(`/api/campaigns/${campaignId}/test`, {
        method: 'POST',
        body: { recipients: emails.split(',').map((s) => s.trim()).filter(Boolean) },
      });
      setResults(r.results);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="테스트 발송하기" onClose={onClose}>
      <label className="field">
        <span>수신자 (쉼표로 구분, 최대 5명)</span>
        <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="me@datasee.co.kr" />
      </label>
      {results ? (
        <div className={results.every((r) => r.ok) ? 'ok-box' : 'error-box'}>
          {results.map((r) => (
            <div key={r.email}>
              {r.email}: {r.ok ? '발송됨' : r.error}
            </div>
          ))}
        </div>
      ) : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          닫기
        </button>
        <button className="btn primary" onClick={send} disabled={busy || !emails}>
          테스트 발송
        </button>
      </div>
    </Modal>
  );
}

function ScheduleModal({
  campaignId,
  save,
  onClose,
  onDone,
}: {
  campaignId: string;
  save: () => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [when, setWhen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await save();
      await api(`/api/campaigns/${campaignId}/schedule`, {
        method: 'POST',
        body: { scheduled_at: new Date(when).toISOString() },
      });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="예약 발송" onClose={onClose}>
      <label className="field">
        <span>발송 시각</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          취소
        </button>
        <button className="btn primary" onClick={submit} disabled={!when || busy}>
          예약하기
        </button>
      </div>
    </Modal>
  );
}
