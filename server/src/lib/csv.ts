/** 의존성 없는 최소 CSV. 엑셀이 여는 UTF-8 BOM을 붙인다. */

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length && !columns?.length) return '﻿';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = cols.map(cell).join(',');
  const body = rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n');
  return `﻿${head}\n${body}`;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // 앞에 =,+,-,@ 가 오면 엑셀이 수식으로 실행한다 — 접두 따옴표로 막는다.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function parseCsv(input: string): Array<Record<string, string>> {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
