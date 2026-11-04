import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Layout } from './components/Layout';
import Dashboard from './pages/Dashboard';
import Emails from './pages/Emails';
import CampaignEditor from './pages/CampaignEditor';
import CampaignStats from './pages/CampaignStats';
import Lists from './pages/Lists';
import ListDetail from './pages/ListDetail';
import Templates from './pages/Templates';
import TemplateEditor from './pages/TemplateEditor';
import Stats from './pages/Stats';
import Settings from './pages/Settings';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [authState, setAuthState] = useState<'loading' | 'in' | 'out'>('loading');
  const [sso, setSso] = useState(false);

  useEffect(() => {
    // 세션이 없으면 SSO 를 바로 시작한다 — gatehouse 세션이 있으면 클릭 없이 들어온다.
    // `?local=1` 이면 버튼 화면을 보여 준다(로그아웃이 여기로 보낸다). IdP 가 세션 없이
    // 돌려보낸 경우 60초 동안은 자동 시작을 멈춰 루프를 막는다.
    const AUTO_FLAG = 'mailroom_sso_auto';
    const local = new URLSearchParams(window.location.search).get('local') === '1';
    const bounced = Number(sessionStorage.getItem(AUTO_FLAG) ?? 0) > Date.now() - 60_000;
    Promise.all([
      api('/api/auth/status').catch(() => ({ sso: false })),
      api('/api/auth/me').catch(() => ({ user: null })),
    ]).then(([s, r]: any[]) => {
      setSso(s.sso);
      if (r.user) {
        sessionStorage.removeItem(AUTO_FLAG);
        setUser(r.user);
        setAuthState('in');
        return;
      }
      if (s.sso && !local && !bounced) {
        sessionStorage.setItem(AUTO_FLAG, String(Date.now()));
        window.location.replace('/api/auth/oidc/start');
        return;
      }
      setAuthState('out');
    });
  }, []);

  if (authState === 'loading') return <div className="empty">불러오는 중…</div>;

  if (authState === 'out') {
    return (
      <div className="login">
        <div className="brand" style={{ fontSize: 24 }}>
          <span className="dot" />
          mailroom
        </div>
        {sso ? (
          <a className="btn primary" href="/api/auth/oidc/start">
            Datasee SSO로 로그인
          </a>
        ) : (
          <div className="warn-box" style={{ maxWidth: 420 }}>
            SSO가 설정되지 않았습니다. 서버에 <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>,{' '}
            <code>OIDC_CLIENT_SECRET</code>을 설정하세요.
          </div>
        )}
      </div>
    );
  }

  return (
    <Layout user={user}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/emails" element={<Emails />} />
        <Route path="/emails/:id" element={<CampaignStats />} />
        <Route path="/emails/:id/edit" element={<CampaignEditor />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/:id/edit" element={<TemplateEditor />} />
        <Route path="/lists" element={<Lists />} />
        <Route path="/lists/:id" element={<ListDetail />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
