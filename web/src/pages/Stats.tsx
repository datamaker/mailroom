import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtNum, pct } from '../api';
import { Empty, StatCard } from '../components/ui';

export default function Stats() {
  const [lists, setLists] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [filters, setFilters] = useState({ from: '', to: '', listIds: '', tags: '', interval: 'week' });

  useEffect(() => {
    api('/api/lists').then((r: any) => setLists(r.lists));
  }, []);

  const load = () => api('/api/stats/overview', { query: filters }).then(setData);
  useEffect(() => {
    load();
  }, [filters.from, filters.to, filters.listIds, filters.tags, filters.interval]);

  return (
    <>
      <h1>통계</h1>
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="row fill">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>시작일</span>
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>종료일</span>
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>주소록</span>
            <select value={filters.listIds} onChange={(e) => setFilters({ ...filters, listIds: e.target.value })}>
              <option value="">전체</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>태그</span>
            <input value={filters.tags} onChange={(e) => setFilters({ ...filters, tags: e.target.value })} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>단위</span>
            <select value={filters.interval} onChange={(e) => setFilters({ ...filters, interval: e.target.value })}>
              <option value="week">주간</option>
              <option value="month">월간</option>
            </select>
          </label>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          발송 완료한 이메일만 집계합니다.
        </div>
      </div>

      {!data ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <>
          <h2>요약 · 이메일 {fmtNum(data.summary.campaigns)}건</h2>
          <div className="cards">
            <StatCard label="발송 성공" count={data.summary.sent} value={data.summary.delivery_rate} />
            <StatCard label="오픈" count={data.summary.opens} value={data.summary.open_rate} />
            <StatCard label="클릭" count={data.summary.clicks} value={data.summary.click_rate} />
            <StatCard label="수신거부" count={data.summary.unsubscribes} value={data.summary.unsubscribe_rate} />
          </div>

          <h2>{filters.interval === 'month' ? '월간' : '주간'} 추이</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>기간</th>
                  <th className="num">발송 성공</th>
                  <th className="num">오픈</th>
                  <th className="num">오픈율</th>
                  <th className="num">클릭</th>
                  <th className="num">클릭률</th>
                  <th className="num">수신거부</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((r: any) => (
                  <tr key={r.bucket}>
                    <td>{fmtDate(r.bucket, false)}</td>
                    <td className="num">{fmtNum(r.sent)}</td>
                    <td className="num">{fmtNum(r.opens)}</td>
                    <td className="num">{pct(r.open_rate)}</td>
                    <td className="num">{fmtNum(r.clicks)}</td>
                    <td className="num">{pct(r.click_rate)}</td>
                    <td className="num">{fmtNum(r.unsubscribes)}</td>
                  </tr>
                ))}
                {!data.series.length ? (
                  <tr>
                    <td colSpan={7}>
                      <Empty>집계할 발송이 없습니다.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <h2>이메일별</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>제목</th>
                  <th>주소록</th>
                  <th className="num">발송 성공</th>
                  <th className="num">오픈율</th>
                  <th className="num">클릭률</th>
                  <th>발송 완료일</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/emails/${c.id}`}>{c.subject}</Link>
                    </td>
                    <td className="muted">{c.list_name}</td>
                    <td className="num">{fmtNum(c.sent_count)}</td>
                    <td className="num">{pct(rate(c.unique_open_count, c.sent_count))}</td>
                    <td className="num">{pct(rate(c.unique_click_count, c.sent_count))}</td>
                    <td className="faint">{fmtDate(c.send_finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function rate(part: number, whole: number) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
