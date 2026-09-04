import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum, pct } from '../api';
import { BarChart, Empty, StatCard } from '../components/ui';

export default function Dashboard() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api('/api/stats/dashboard').then(setData).catch(() => setData({ latest: null, growth: [], recent: [] }));
  }, []);

  if (!data) return <div className="empty">불러오는 중…</div>;
  const l = data.latest;

  return (
    <>
      <h1>대시보드</h1>

      <h2>
        최근 발송한 이메일{' '}
        {l ? (
          <Link to={`/emails/${l.id}`} className="faint">
            {l.subject}
          </Link>
        ) : null}
      </h2>
      {l ? (
        <div className="cards">
          <StatCard label="발송 성공" count={l.sent_count} value={l.delivery_rate} delta={l.delta?.delivery} />
          <StatCard label="오픈" count={l.unique_open_count} value={l.open_rate} delta={l.delta?.open} />
          <StatCard label="클릭" count={l.unique_click_count} value={l.click_rate} delta={l.delta?.click} />
          <StatCard label="수신거부" count={l.unsub_count} value={l.unsubscribe_rate} delta={l.delta?.unsubscribe} />
        </div>
      ) : (
        <Empty>아직 발송한 이메일이 없습니다.</Empty>
      )}

      <h2>구독자</h2>
      <div className="panel">
        <div className="faint" style={{ marginBottom: 8 }}>
          구독 중 {fmtNum(data.subscribers?.subscribed)} · 수신거부 {fmtNum(data.subscribers?.unsubscribed)}
        </div>
        <BarChart
          data={(data.growth ?? []).map((g: any) => ({
            label: `${Number(g.month.slice(5))}월`,
            value: g.subscribers,
          }))}
        />
      </div>

      <h2>최근 발송</h2>
      <div className="panel" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>이메일 제목</th>
              <th className="num">오픈율</th>
              <th className="num">클릭률</th>
            </tr>
          </thead>
          <tbody>
            {(data.recent ?? []).map((r: any) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/emails/${r.id}`}>{r.subject}</Link>
                  <div className="faint">{fmtDate(r.send_finished_at)}</div>
                </td>
                <td className="num">{pct(r.open_rate)}</td>
                <td className="num">{pct(r.click_rate)}</td>
              </tr>
            ))}
            {!data.recent?.length ? (
              <tr>
                <td colSpan={3}>
                  <Empty>발송한 이메일이 없습니다.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
