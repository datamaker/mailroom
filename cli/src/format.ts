import chalk from 'chalk';

/** 한글은 폭이 2 — 터미널 표 정렬이 깨지지 않게 실제 표시 폭으로 센다. */
export function displayWidth(s: string) {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    w +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
        ? 2
        : 1;
  }
  return w;
}

function padTo(s: string, width: number) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export function truncate(s: string, max: number) {
  if (displayWidth(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

export function table(rows: Array<Record<string, unknown>>, columns?: string[]) {
  if (!rows.length) return chalk.dim('(없음)');
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(displayWidth(c), ...rows.map((r) => displayWidth(String(r[c] ?? ''))))
  );
  const head = cols.map((c, i) => chalk.bold(padTo(c, widths[i]))).join('  ');
  const body = rows
    .map((r) => cols.map((c, i) => padTo(String(r[c] ?? ''), widths[i])).join('  '))
    .join('\n');
  return `${head}\n${body}`;
}

export function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function status(s: string) {
  const map: Record<string, (t: string) => string> = {
    draft: chalk.dim,
    scheduled: chalk.cyan,
    sending: chalk.yellow,
    sent: chalk.green,
    paused: chalk.magenta,
    failed: chalk.red,
    canceled: chalk.dim,
    subscribed: chalk.green,
    unsubscribed: chalk.dim,
    deleted: chalk.red,
  };
  return (map[s] ?? ((t: string) => t))(s);
}

export function pct(v: number | null | undefined) {
  return v === null || v === undefined ? '-' : `${v}%`;
}

export function when(v: string | null | undefined) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}
