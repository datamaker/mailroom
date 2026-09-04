import type { ReactNode } from 'react';
import { STATUS_LABEL, fmtNum, pct } from '../api';

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function StatCard({
  label,
  count,
  value,
  delta,
  suffix = '%',
}: {
  label: string;
  count?: number;
  value: number | string;
  delta?: number | null;
  suffix?: string;
}) {
  return (
    <div className="card">
      <div className="label">
        {label} {count !== undefined ? <b>{fmtNum(count)}</b> : null}
      </div>
      <div className="value">
        {value}
        {suffix}
      </div>
      {delta !== undefined && delta !== null ? (
        <div className="delta">
          지난 이메일보다{' '}
          <span className={delta >= 0 ? 'up' : 'down'}>
            {delta >= 0 ? '↑' : '↓'} {Math.abs(Math.round(delta * 10) / 10)}%P
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function BarChart({ data, format = fmtNum }: { data: Array<{ label: string; value: number }>; format?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bars">
      {data.map((d, i) => (
        <div className="bar" key={i}>
          <div className="cap">{format(d.value)}</div>
          <div className="fill" style={{ height: `${Math.max(2, (d.value / max) * 130)}px` }} />
          <div className="axis">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

export function Rate({ part, whole }: { part: number; whole: number }) {
  if (!whole) return <span className="faint">-</span>;
  return <>{pct(Math.round((part / whole) * 1000) / 10)}</>;
}
