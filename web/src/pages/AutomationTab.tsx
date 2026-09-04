import { useEffect, useState } from 'react';
import { api, fmtDate, fmtNum } from '../api';
import { Empty } from '../components/ui';

const TRIGGER_HELP: Record<string, string> = {
  subscribe: '주소록에 새로 구독한 사람에게. 웰컴 메일에 씁니다.',
  campaign_opened: '고른 이메일을 연 사람에게. 관심 보인 사람에게 이어서 보낼 때.',
  campaign_not_opened: '고른 이메일을 정해진 시간 안에 열지 않은 사람에게. 제목을 바꿔 다시 보낼 때.',
  campaign_clicked: '고른 이메일의 링크를 누른 사람에게.',
  field_date: '날짜 필드(가입날짜 등)를 기준으로. 가입 1주년 같은 것.',
};

const DELAY_OPTIONS = [
  { v: 0, l: '바로' },
  { v: 60, l: '1시간 뒤' },
  { v: 60 * 24, l: '1일 뒤' },
  { v: 60 * 24 * 3, l: '3일 뒤' },
  { v: 60 * 24 * 7, l: '7일 뒤' },
];

/**
 * 자동 이메일 설정. 일반 이메일의 "발송" 탭 자리에 들어간다.
 * 일반 발송은 한 번 쏘고 끝이지만 이건 켜 두면 계속 나가므로, 켜고 끄는 것과
 * 지금까지 누구에게 나갔는지를 같은 화면에서 본다.
 */
export function AutomationTab({ c, save, reload }: { c: any; save: () => Promise<void>; reload: () => void }) {
  const [trigger, setTrigger] = useState<any>(c.trigger?.type ? c.trigger : { type: 'subscribe', delayMinutes: 0 });
  const [sent, setSent] = useState<any[]>([]);
  const [runs, setRuns] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = c.status === 'active';

  useEffect(() => {
    api('/api/campaigns', { query: { status: 'sent', listId: c.list_id, limit: 30 } }).then((r: any) =>
      setSent(r.campaigns)
    );
  }, [c.list_id]);

  const loadRuns = () => api(`/api/campaigns/${c.id}/runs`).then(setRuns);
  useEffect(() => {
    loadRuns();
    if (!active) return;
    const t = setInterval(loadRuns, 15_000);
    return () => clearInterval(t);
  }, [c.id, active]);

  const patchTrigger = async (next: any) => {
    setTrigger(next);
    await api(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { type: 'automation', trigger: next } });
  };

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      await save();
      if (active) {
        await api(`/api/campaigns/${c.id}/deactivate`, { method: 'POST' });
      } else {
        await api(`/api/campaigns/${c.id}/activate`, { method: 'POST' });
      }
      reload();
      loadRuns();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const needsCampaign = trigger.type.startsWith('campaign_');

  return (
    <div style={{ maxWidth: 680 }}>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>언제 보낼까요</h3>
        <label className="field">
          <span>발동 조건</span>
          <select
            value={trigger.type}
            disabled={active}
            onChange={(e) => patchTrigger({ ...trigger, type: e.target.value, campaignId: undefined })}
          >
            <option value="subscribe">구독했을 때</option>
            <option value="campaign_opened">특정 이메일을 오픈했을 때</option>
            <option value="campaign_not_opened">특정 이메일을 오픈하지 않았을 때</option>
            <option value="campaign_clicked">특정 이메일의 링크를 클릭했을 때</option>
            <option value="field_date">특정 날짜 필드 기준</option>
          </select>
          <div className="hint">{TRIGGER_HELP[trigger.type]}</div>
        </label>

        {needsCampaign ? (
          <label className="field">
            <span>기준이 될 이메일</span>
            <select
              value={trigger.campaignId ?? ''}
              disabled={active}
              onChange={(e) => patchTrigger({ ...trigger, campaignId: e.target.value })}
            >
              <option value="">선택하세요</option>
              {sent.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.subject}
                </option>
              ))}
            </select>
            {!sent.length ? <div className="hint">이 주소록으로 발송 완료된 이메일이 아직 없습니다.</div> : null}
          </label>
        ) : null}

        {trigger.type === 'field_date' ? (
          <div className="row">
            <label className="field">
              <span>날짜 필드 key</span>
              <input
                value={trigger.key ?? ''}
                disabled={active}
                placeholder="created_at"
                onChange={(e) => patchTrigger({ ...trigger, key: e.target.value })}
              />
            </label>
            <label className="field">
              <span>며칠 전/후</span>
              <input
                type="number"
                value={trigger.offsetDays ?? 0}
                disabled={active}
                onChange={(e) => patchTrigger({ ...trigger, offsetDays: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>보낼 시각</span>
              <input
                type="number"
                min={0}
                max={23}
                value={trigger.sendHour ?? 9}
                disabled={active}
                onChange={(e) => patchTrigger({ ...trigger, sendHour: Number(e.target.value) })}
              />
            </label>
          </div>
        ) : (
          <label className="field">
            <span>얼마나 기다렸다 보낼까요</span>
            <select
              value={String(trigger.delayMinutes ?? 0)}
              disabled={active}
              onChange={(e) => patchTrigger({ ...trigger, delayMinutes: Number(e.target.value) })}
            >
              {DELAY_OPTIONS.map((d) => (
                <option key={d.v} value={d.v}>
                  {d.l}
                </option>
              ))}
            </select>
          </label>
        )}

        {trigger.type === 'field_date' ? (
          <label className="check">
            <input
              type="checkbox"
              checked={!!trigger.yearly}
              disabled={active}
              onChange={(e) => patchTrigger({ ...trigger, yearly: e.target.checked })}
            />
            해마다 반복 (기념일)
          </label>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: '0 0 4px' }}>{active ? '실행 중입니다' : '꺼져 있습니다'}</h3>
            <div className="faint">
              {active
                ? '조건이 맞는 사람에게 계속 나갑니다.'
                : '켜면 그 시점 이후에 조건이 맞는 사람에게만 나갑니다. 기존 구독자에게 소급 발송되지 않습니다.'}
            </div>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button className={`btn ${active ? '' : 'primary'}`} onClick={toggle} disabled={busy}>
              {active ? '끄기' : '켜기'}
            </button>
          </div>
        </div>
        {error ? <div className="error-box" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>

      <h2>실행 현황</h2>
      {runs ? (
        <>
          <div className="cards" style={{ marginBottom: 14 }}>
            <div className="card">
              <div className="label">예약됨</div>
              <div className="value">{fmtNum(runs.summary.scheduled)}</div>
            </div>
            <div className="card">
              <div className="label">발송됨</div>
              <div className="value">{fmtNum(runs.summary.sent)}</div>
            </div>
            <div className="card">
              <div className="label">건너뜀</div>
              <div className="value">{fmtNum(runs.summary.skipped)}</div>
            </div>
            <div className="card">
              <div className="label">실패</div>
              <div className="value">{fmtNum(runs.summary.failed)}</div>
            </div>
          </div>
          <div className="panel" style={{ padding: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>상태</th>
                  <th>예정</th>
                  <th>발송</th>
                  <th>사유</th>
                </tr>
              </thead>
              <tbody>
                {runs.runs.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.email ?? <span className="faint">(삭제된 구독자)</span>}</td>
                    <td>
                      <span className={`badge ${r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : 'draft'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="faint">{fmtDate(r.scheduled_at)}</td>
                    <td className="faint">{fmtDate(r.sent_at)}</td>
                    <td className="faint">{r.error ?? ''}</td>
                  </tr>
                ))}
                {!runs.runs.length ? (
                  <tr>
                    <td colSpan={5}>
                      <Empty>아직 나간 메일이 없습니다.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="faint">불러오는 중…</div>
      )}
    </div>
  );
}
