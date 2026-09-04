import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum, pct } from '../api';
import { Badge, Empty, StatCard } from '../components/ui';

export default function CampaignStats() {
  const { id } = useParams();
  const [s, setS] = useState<any>(null);
  const [tab, setTab] = useState<'dashboard' | 'recipients'>('dashboard');

  useEffect(() => {
    const load = () => api(`/api/campaigns/${id}/stats`).then(setS);
    load();
    // 발송 중에는 수치가 계속 바뀐다.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [id]);

  if (!s) return <div className="empty">불러오는 중…</div>;
  const t = s.totals;

  return (
    <>
      <div className="toolbar">
        <Link to="/emails" className="btn sm">
          ← 목록
        </Link>
        <h1 style={{ margin: 0, fontSize: 20 }}>{s.campaign.subject}</h1>
        <Badge status={s.campaign.status} />
        <div className="spacer" />
        {s.campaign.public_slug ? (
          <a className="btn sm" href={`/w/${s.campaign.public_slug}`} target="_blank" rel="noreferrer">
            웹에서 보기
          </a>
        ) : null}
        <a className="btn sm" href={`/api/campaigns/${id}/stats/export`}>
          통계 내려받기
        </a>
      </div>

      <div className="tabs">
        <a className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')} style={{ cursor: 'pointer' }}>
          대시보드
        </a>
        <a className={tab === 'recipients' ? 'active' : ''} onClick={() => setTab('recipients')} style={{ cursor: 'pointer' }}>
          수신자별 결과
        </a>
      </div>

      {tab === 'recipients' ? (
        <Recipients id={id!} />
      ) : (
        <>
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="row">
              <div>
                <div className="faint">발신자</div>
                <div>
                  {s.campaign.sender_name} &lt;{s.campaign.sender_email}&gt;
                </div>
              </div>
              <div>
                <div className="faint">발송 시작</div>
                <div>{fmtDate(s.campaign.send_started_at)}</div>
              </div>
              <div>
                <div className="faint">발송 완료</div>
                <div>{fmtDate(s.campaign.send_finished_at)}</div>
              </div>
            </div>
          </div>

          <h2>성과</h2>
          <div className="cards">
            <StatCard label="발송 성공" count={t.sent} value={t.delivery_rate} />
            <StatCard label="오픈" count={t.unique_opens} value={t.open_rate} />
            <StatCard label="클릭" count={t.unique_clicks} value={t.click_rate} />
            <StatCard label="수신거부" count={t.unsubscribes} value={t.unsubscribe_rate} />
          </div>
          {t.failed || t.bounced || t.complaints ? (
            <div className="faint" style={{ marginTop: 10 }}>
              실패 {fmtNum(t.failed)} · 바운스 {fmtNum(t.bounced)} · 스팸신고 {fmtNum(t.complaints)}
            </div>
          ) : null}

          <h2>시간별 오픈·클릭</h2>
          <div className="panel">
            {s.timeline.length ? <Timeline rows={s.timeline} /> : <Empty>아직 기록이 없습니다.</Empty>}
          </div>

          <h2>많이 클릭한 링크</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>링크</th>
                  <th className="num">클릭</th>
                  <th className="num">순 클릭</th>
                </tr>
              </thead>
              <tbody>
                {s.links.map((l: any) => (
                  <tr key={l.id}>
                    <td className="mono">{l.url}</td>
                    <td className="num">{fmtNum(l.click_count)}</td>
                    <td className="num">{fmtNum(l.unique_click_count)}</td>
                  </tr>
                ))}
                {!s.links.length ? (
                  <tr>
                    <td colSpan={3}>
                      <Empty>링크가 없습니다.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ alignItems: 'flex-start', marginTop: 8 }}>
            <div>
              <h2>많이 오픈한 구독자</h2>
              <div className="panel" style={{ padding: 0 }}>
                <table className="data">
                  <tbody>
                    {s.topOpeners.map((r: any) => (
                      <tr key={r.email}>
                        <td>{r.email}</td>
                        <td className="num">{r.open_count}</td>
                      </tr>
                    ))}
                    {!s.topOpeners.length ? (
                      <tr>
                        <td>
                          <Empty>없음</Empty>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h2>많이 클릭한 구독자</h2>
              <div className="panel" style={{ padding: 0 }}>
                <table className="data">
                  <tbody>
                    {s.topClickers.map((r: any) => (
                      <tr key={r.email}>
                        <td>{r.email}</td>
                        <td className="num">{r.click_count}</td>
                      </tr>
                    ))}
                    {!s.topClickers.length ? (
                      <tr>
                        <td>
                          <Empty>없음</Empty>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <h2>모바일 vs 데스크톱</h2>
          <div className="panel">
            <Devices rows={s.devices} />
          </div>
        </>
      )}
    </>
  );
}

function Timeline({ rows }: { rows: any[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.opens, r.clicks)));
  return (
    <div className="bars" style={{ height: 200 }}>
      {rows.map((r, i) => (
        <div className="bar" key={i} title={`${fmtDate(r.hour)} 오픈 ${r.opens} · 클릭 ${r.clicks}`}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', width: '100%', height: 150 }}>
            <div style={{ flex: 1, background: '#facc15', height: `${(r.opens / max) * 100}%`, borderRadius: '2px 2px 0 0' }} />
            <div style={{ flex: 1, background: '#3b82f6', height: `${(r.clicks / max) * 100}%`, borderRadius: '2px 2px 0 0' }} />
          </div>
          <div className="axis">{new Date(r.hour).getHours()}시</div>
        </div>
      ))}
    </div>
  );
}

function Devices({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty>아직 오픈 기록이 없습니다.</Empty>;
  const total = rows.reduce((a, r) => a + r.count, 0);
  const group = (key: string) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r[key]] = (m[r[key]] ?? 0) + r.count;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  return (
    <div className="row">
      <div>
        <h3>기기</h3>
        {group('device').map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{k === 'mobile' ? '모바일' : k === 'desktop' ? '데스크톱' : '알 수 없음'}</span>
            <span>{pct(Math.round((v / total) * 1000) / 10)}</span>
          </div>
        ))}
      </div>
      <div>
        <h3>운영체제</h3>
        {group('os').map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{k}</span>
            <span>{pct(Math.round((v / total) * 1000) / 10)}</span>
          </div>
        ))}
      </div>
      <div>
        <h3>메일 클라이언트</h3>
        {group('client').map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{k}</span>
            <span>{pct(Math.round((v / total) * 1000) / 10)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Recipients({ id }: { id: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api(`/api/campaigns/${id}/recipients`, { query: { event: filter || undefined, limit: 200 } }).then((r: any) => {
      setRows(r.recipients);
      setTotal(r.total);
    });
  }, [id, filter]);

  return (
    <>
      <div className="toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">전체</option>
          <option value="opened">오픈함</option>
          <option value="clicked">클릭함</option>
          <option value="not_opened">오픈 안 함</option>
        </select>
        <span className="faint">{fmtNum(total)}명</span>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이메일</th>
              <th>상태</th>
              <th className="num">오픈</th>
              <th className="num">클릭</th>
              <th>발송 시각</th>
              <th>오류</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.email}</td>
                <td>
                  <Badge status={r.status} />
                </td>
                <td className="num">{r.open_count || '-'}</td>
                <td className="num">{r.click_count || '-'}</td>
                <td className="faint">{fmtDate(r.sent_at)}</td>
                <td className="faint">{r.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
