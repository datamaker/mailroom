import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

interface Props {
  user: { email: string; name: string | null; role: string } | null;
  children: ReactNode;
}

const NAV = [
  { to: '/', label: '대시보드', exact: true },
  { to: '/emails', label: '이메일' },
  { to: '/lists', label: '주소록' },
  { to: '/stats', label: '통계' },
  { to: '/settings', label: '설정' },
];

export function Layout({ user, children }: Props) {
  const loc = useLocation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          mailroom
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={() => {
              const active = n.exact ? loc.pathname === n.to : loc.pathname.startsWith(n.to);
              return `nav-item${active ? ' active' : ''}`;
            }}
          >
            {n.label}
          </NavLink>
        ))}
        <div className="sidebar-footer">{user?.email ?? ''}</div>
      </aside>
      <div className="main">
        <div className="topbar">
          {user ? (
            <>
              <span>
                {user.name ?? user.email} <span className="faint">({user.role})</span>
              </span>
              <button
                className="btn sm"
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
                  window.location.href = '/';
                }}
              >
                로그아웃
              </button>
            </>
          ) : null}
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
