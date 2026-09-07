import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNum, pct } from '../api';
import { Badge, Empty, Modal, StatCard } from '../components/ui';

export default function CampaignStats() {
  const { id } = useParams();
  const [s, setS] = useState<any>(null);
  const [tab, setTab] = useState<'dashboard' | 'recipients'>('dashboard');
  // 대시보드 위에 겹쳐 띄우는 상세 목록. null 이면 아무것도 안 띄운다.
  const [view, setView] = useState<View>(null);

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

          <SectionHead title="많이 클릭한 링크">
            <button className="btn sm" onClick={() => setView({ kind: 'clickmap' })}>
              클릭맵 보기
            </button>
            <button className="btn sm" onClick={() => setView({ kind: 'links' })}>
              더보기
            </button>
          </SectionHead>
          <div className="panel" style={{ padding: 0 }}>
            <LinkTable
              rows={s.links.slice(0, 5)}
              onPick={(l) => setView({ kind: 'linkClicks', link: l })}
            />
          </div>

          <div className="row" style={{ alignItems: 'flex-start', marginTop: 8 }}>
            <div style={{ minWidth: 0 }}>
              <SectionHead title="많이 오픈한 구독자">
                <button className="btn sm" onClick={() => setView({ kind: 'engagement', type: 'open' })}>
                  더보기
                </button>
              </SectionHead>
              <div className="panel" style={{ padding: 0 }}>
                <PeopleTable rows={s.topOpeners} countKey="open_count" />
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <SectionHead title="많이 클릭한 구독자">
                <button className="btn sm" onClick={() => setView({ kind: 'engagement', type: 'click' })}>
                  더보기
                </button>
              </SectionHead>
              <div className="panel" style={{ padding: 0 }}>
                <PeopleTable rows={s.topClickers} countKey="click_count" />
              </div>
            </div>
          </div>

          <h2>모바일 vs 데스크톱</h2>
          <div className="panel">
            <Devices rows={s.devices} />
          </div>
        </>
      )}

      {view?.kind === 'clickmap' ? (
        <ClickMapModal
          id={id!}
          onClose={() => setView(null)}
          onPick={(link) => setView({ kind: 'linkClicks', link })}
        />
      ) : null}
      {view?.kind === 'links' ? (
        <LinksModal
          id={id!}
          onClose={() => setView(null)}
          onPick={(link) => setView({ kind: 'linkClicks', link })}
        />
      ) : null}
      {view?.kind === 'linkClicks' ? (
        <LinkClicksModal id={id!} link={view.link} onClose={() => setView(null)} />
      ) : null}
      {view?.kind === 'engagement' ? (
        <EngagementModal id={id!} type={view.type} onClose={() => setView(null)} />
      ) : null}
    </>
  );
}

type View =
  | null
  | { kind: 'clickmap' }
  | { kind: 'links' }
  | { kind: 'linkClicks'; link: LinkRow }
  | { kind: 'engagement'; type: 'open' | 'click' };

/** 구독자 상세로 이어 준다 — 목록에서 사람을 눌러 그 사람의 이력으로 넘어간다. */
function Person({ row }: { row: { email: string; subscriber_id?: string; list_id?: string } }) {
  if (!row.subscriber_id || !row.list_id) return <>{row.email}</>;
  return <Link to={`/lists/${row.list_id}?sub=${row.subscriber_id}`}>{row.email}</Link>;
}

/** 저장된 URL 은 퍼센트 인코딩이라 그대로 보이면 못 읽는다. */
function prettyUrl(u: string): string {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
}

interface LinkRow {
  id: number;
  url: string;
  click_count: number;
  unique_click_count: number;
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <div className="spacer" />
      {children}
    </div>
  );
}

/** 링크는 길어서 줄여 보여주고, 숫자 칸은 항상 보이게 고정한다. */
function LinkTable({ rows, onPick }: { rows: LinkRow[]; onPick?: (l: LinkRow) => void }) {
  if (!rows.length) return <Empty>클릭된 링크가 없습니다.</Empty>;
  return (
    <table className="data fit">
      <thead>
        <tr>
          <th>링크</th>
          <th className="num">클릭</th>
          <th className="num">순 클릭</th>
          {onPick ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="trunc mono" title={l.url}>
              {prettyUrl(l.url)}
            </td>
            <td className="num">{fmtNum(l.click_count)}</td>
            <td className="num">{fmtNum(l.unique_click_count)}</td>
            {onPick ? (
              <td className="num">
                <button className="btn sm" onClick={() => onPick(l)} disabled={!l.click_count}>
                  누가 눌렀나
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PeopleTable({ rows, countKey }: { rows: any[]; countKey: string }) {
  if (!rows.length) return <Empty>없음</Empty>;
  return (
    <table className="data fit">
      <tbody>
        {rows.map((r) => (
          <tr key={r.email}>
            <td className="trunc" title={r.email}>
              {r.email}
            </td>
            <td className="num">{fmtNum(r[countKey])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 클릭맵: 보낸 메일을 그대로 띄우고 링크 위에 클릭 수를 겹쳐 그린다.
 * iframe 은 스크립트를 못 돌리게 막되(allow-same-origin 만) 부모가 앵커 위치를
 * 잴 수 있게 열어 둔다. 클릭은 겹쳐 놓은 층에서 받는다.
 */
function ClickMapModal({
  id,
  onClose,
  onPick,
}: {
  id: string;
  onClose: () => void;
  onPick: (l: LinkRow) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [marks, setMarks] = useState<any[]>([]);
  const [showCold, setShowCold] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api(`/api/campaigns/${id}/clickmap`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [id]);

  const measure = () => {
    const f = frame.current;
    const doc = f?.contentDocument;
    if (!f || !doc || !data) return;
    f.style.height = `${doc.documentElement.scrollHeight}px`;
    const width = f.clientWidth;
    const byId = new Map<string, any>(data.links.map((l: any) => [String(l.id), l]));
    const out: any[] = [];
    doc.querySelectorAll('[data-mr-link]').forEach((el) => {
      const l = byId.get(el.getAttribute('data-mr-link') ?? '');
      if (!l) return;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width && !r.height) return;
      // 오른쪽 끝 링크는 뱃지가 잘리므로 링크 안쪽으로 뒤집어 붙인다.
      out.push({ ...l, top: r.top, left: r.left, w: r.width, h: r.height, flip: r.left + r.width + 72 > width });
    });
    setMarks(out);
  };

  useEffect(() => {
    if (!data) return;
    // 이미지가 늦게 뜨면 위치가 밀리므로 한 번 더 잰다.
    const t = setTimeout(measure, 400);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [data]);

  return (
    <Modal title="클릭맵" onClose={onClose} size="xwide">
      {err ? <Empty>{err}</Empty> : null}
      {!data && !err ? <Empty>불러오는 중…</Empty> : null}
      {data ? (
        <>
          <div className="toolbar" style={{ marginTop: 0 }}>
            <span className="faint">
              전체 클릭 {fmtNum(data.totalClicks)}회 · 링크를 누르면 누가 눌렀는지 볼 수 있습니다.
            </span>
            <div className="spacer" />
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={showCold} onChange={(e) => setShowCold(e.target.checked)} />
              클릭 0회 링크도 표시
            </label>
          </div>
          <div className="clickmap">
            <iframe
              ref={frame}
              title="클릭맵"
              sandbox="allow-same-origin"
              srcDoc={data.html}
              onLoad={measure}
            />
            <div className="clickmap-layer">
              {marks
                .filter((m) => showCold || m.click_count)
                .map((m, i) => (
                <div key={i}>
                  <div
                    className={`clickmap-box${m.click_count ? '' : ' cold'}`}
                    style={{ top: m.top, left: m.left, width: m.w, height: m.h }}
                    title={m.url}
                    onClick={() => m.click_count && onPick(m)}
                  />
                  <div
                    className={`clickmap-tag${m.click_count ? '' : ' cold'}${m.flip ? ' flip' : ''}`}
                    style={{ top: m.top, left: m.left + m.w }}
                    onClick={() => m.click_count && onPick(m)}
                  >
                    {fmtNum(m.click_count)} · {m.pct}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function LinksModal({
  id,
  onClose,
  onPick,
}: {
  id: string;
  onClose: () => void;
  onPick: (l: LinkRow) => void;
}) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api(`/api/campaigns/${id}/links`, { query: { limit: 500 } }).then(setD);
  }, [id]);
  return (
    <Modal title="링크별 클릭" onClose={onClose} size="xwide">
      {!d ? (
        <Empty>불러오는 중…</Empty>
      ) : (
        <>
          <p className="faint" style={{ marginTop: 0 }}>링크 {fmtNum(d.total)}개</p>
          <div className="modal-table">
            <LinkTable rows={d.links} onPick={onPick} />
          </div>
        </>
      )}
    </Modal>
  );
}

function LinkClicksModal({ id, link, onClose }: { id: string; link: LinkRow; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api(`/api/campaigns/${id}/links/${link.id}/clicks`, { query: { limit: 500 } }).then(setD);
  }, [id, link.id]);
  return (
    <Modal title="이 링크를 누른 사람" onClose={onClose} size="xwide">
      <p className="mono faint" style={{ marginTop: 0, wordBreak: 'break-all' }}>{prettyUrl(link.url)}</p>
      {!d ? (
        <Empty>불러오는 중…</Empty>
      ) : (
        <>
          <div className="toolbar" style={{ marginTop: 0 }}>
            <span className="faint">
              클릭 {fmtNum(d.total)}회 · 순 클릭 {fmtNum(link.unique_click_count)}명
            </span>
            <div className="spacer" />
            <a className="btn sm" href={`/api/campaigns/${id}/links/${link.id}/clicks/export`}>
              파일로 내보내기
            </a>
          </div>
          <div className="modal-table">
            <table className="data fit">
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>이름</th>
                  <th>클릭일</th>
                  <th>환경</th>
                </tr>
              </thead>
              <tbody>
                {d.clicks.map((c: any, i: number) => (
                  <tr key={i}>
                    <td className="trunc" title={c.email}>
                      <Person row={c} />
                    </td>
                    <td className="trunc">{c.fields?.name ?? ''}</td>
                    <td className="nowrap faint">{fmtDate(c.created_at)}</td>
                    <td className="nowrap faint">
                      {c.device === 'mobile' ? '모바일' : c.device === 'desktop' ? '데스크톱' : '기타'} · {c.client}
                    </td>
                  </tr>
                ))}
                {!d.clicks.length ? (
                  <tr>
                    <td colSpan={4}>
                      <Empty>아직 클릭이 없습니다.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function EngagementModal({
  id,
  type,
  onClose,
}: {
  id: string;
  type: 'open' | 'click';
  onClose: () => void;
}) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api(`/api/campaigns/${id}/engagement`, { query: { type, limit: 1000 } }).then(setD);
  }, [id, type]);
  const label = type === 'click' ? '클릭' : '오픈';
  return (
    <Modal title={`${label}한 구독자`} onClose={onClose} size="xwide">
      {!d ? (
        <Empty>불러오는 중…</Empty>
      ) : (
        <>
          <div className="toolbar" style={{ marginTop: 0 }}>
            <span className="faint">{fmtNum(d.total)}명</span>
            <div className="spacer" />
            <a className="btn sm" href={`/api/campaigns/${id}/engagement/export?type=${type}`}>
              파일로 내보내기
            </a>
          </div>
          <div className="modal-table">
            <table className="data fit">
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>이름</th>
                  <th className="num">{label}(중복 포함)</th>
                  <th>마지막 {label}일</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td className="trunc" title={r.email}>
                      <Person row={r} />
                    </td>
                    <td className="trunc">{r.fields?.name ?? ''}</td>
                    <td className="num">{fmtNum(r.count)}</td>
                    <td className="nowrap faint">{fmtDate(r.last_at)}</td>
                  </tr>
                ))}
                {!d.rows.length ? (
                  <tr>
                    <td colSpan={4}>
                      <Empty>없습니다.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
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
