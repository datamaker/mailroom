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
    api('/api/auth/status').then((s: any) => setSso(s.sso));
    api('/api/auth/me')
      .then((r: any) => {
        setUser(r.user);
        setAuthState(r.user ? 'in' : 'out');
      })
      .catch(() => setAuthState('out'));
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
