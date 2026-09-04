import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { api, apiRaw } from '../api.js';
import { json, status, table, truncate, when } from '../format.js';

export function subscribersCommand() {
  const cmd = new Command('subscribers').alias('subs').description('구독자 관리');

  cmd
    .command('ls <listId>')
    .description('구독자 목록')
    .option('-q, --query <text>', '이메일/필드 값 검색')
    .option('--status <status>', 'subscribed | unsubscribed | deleted | all', 'subscribed')
    .option('--group <id>', '그룹 ID')
    .option('--segment <id>', '세그먼트 ID')
    .option('--filter <json>', '임시 필터 조건 JSON')
    .option('-n, --limit <n>', '개수', '20')
    .option('--json', 'JSON 출력')
    .action(async (listId, opts) => {
      const res = await api<any>(`/api/lists/${listId}/subscribers`, {
        query: {
          q: opts.query,
          status: opts.status,
          groupId: opts.group,
          segmentId: opts.segment,
          filter: opts.filter,
          limit: opts.limit,
        },
      });
      if (opts.json) return console.log(json(res));
      console.log(chalk.dim(`${res.total}명 중 ${res.subscribers.length}명`));
      console.log(
        table(
          res.subscribers.map((s: any) => ({
            이메일: truncate(s.email, 32),
            상태: status(s.status),
            이름: truncate(String(s.fields?.name ?? ''), 12),
            회사: truncate(String(s.fields?.company ?? ''), 20),
            광고: s.ad_agreed ? 'Y' : '',
            그룹: (s.groups ?? []).map((g: any) => g.name).join(','),
            구독일: when(s.subscribed_at),
          }))
        )
      );
    });

  cmd
    .command('add <listId>')
    .description('구독자 추가 (email=... 형태로 필드 지정)')
    .requiredOption('-e, --email <email>', '이메일 주소')
    .option('-f, --field <key=value...>', '필드 값', collect, [])
    .option('--ad-agreed', '광고성 정보 수신 동의')
    .option('--groups <ids>', '쉼표로 구분한 그룹 ID')
    .action(async (listId, opts) => {
      const fields = Object.fromEntries(
        (opts.field as string[]).map((kv) => {
          const i = kv.indexOf('=');
          return [kv.slice(0, i), kv.slice(i + 1)];
        })
      );
      const res = await api<any>(`/api/lists/${listId}/subscribers`, {
        method: 'POST',
        body: {
          subscribers: [{ email: opts.email, ...fields, ad_agreed: opts.adAgreed }],
          groupIds: opts.groups?.split(','),
        },
      });
      console.log(`추가 ${chalk.green(res.created)} · 갱신 ${res.updated} · 건너뜀 ${res.skipped}`);
      for (const e of res.errors) console.log(chalk.red(`  ${e.email}: ${e.reason}`));
    });

  cmd
    .command('import <listId> <csvFile>')
    .description('CSV 파일로 일괄 추가 (헤더는 필드 이름 또는 key)')
    .option('--groups <ids>', '쉼표로 구분한 그룹 ID')
    .option('--clear-empty', '빈 값이면 기존 값을 지운다')
    .action(async (listId, file, opts) => {
      const csv = readFileSync(file, 'utf8');
      const res = await api<any>(`/api/lists/${listId}/subscribers/import`, {
        method: 'POST',
        body: { csv, groupIds: opts.groups?.split(','), clearEmpty: opts.clearEmpty },
      });
      console.log(`추가 ${chalk.green(res.created)} · 갱신 ${res.updated} · 건너뜀 ${res.skipped}`);
      for (const e of res.errors.slice(0, 20)) console.log(chalk.red(`  ${e.email}: ${e.reason}`));
      if (res.errors.length > 20) console.log(chalk.dim(`  ...외 ${res.errors.length - 20}건`));
    });

  cmd
    .command('export <listId> [outFile]')
    .description('CSV 내려받기')
    .option('--status <status>', 'subscribed | unsubscribed | all', 'subscribed')
    .action(async (listId, outFile, opts) => {
      const csv = await apiRaw(`/api/lists/${listId}/subscribers/export?status=${opts.status}`);
      if (outFile) {
        writeFileSync(outFile, csv);
        console.log(`${chalk.green('저장됨')} ${outFile}`);
      } else {
        process.stdout.write(csv);
      }
    });

  cmd
    .command('status <listId> <newStatus>')
    .description('상태 일괄 변경 (subscribed | unsubscribed | deleted)')
    .requiredOption('-e, --emails <emails>', '쉼표로 구분한 이메일')
    .action(async (listId, newStatus, opts) => {
      const res = await api<any>(`/api/lists/${listId}/subscribers/status`, {
        method: 'POST',
        body: { emails: opts.emails.split(','), status: newStatus },
      });
      console.log(`${res.changed}명 변경됨`);
    });

  cmd
    .command('show <listId> <subscriberId>')
    .description('구독자 상세 + 활동 이력')
    .action(async (listId, subId) => {
      const res = await api<any>(`/api/lists/${listId}/subscribers/${subId}`);
      console.log(chalk.bold(res.subscriber.email), status(res.subscriber.status));
      console.log(json(res.subscriber.fields));
      if (res.groups.length) console.log('그룹:', res.groups.map((g: any) => g.name).join(', '));
      if (res.activity.length) {
        console.log('\n' + chalk.bold('활동'));
        console.log(
          table(res.activity.map((a: any) => ({ 시각: when(a.created_at), 유형: a.type, 이메일: truncate(a.subject ?? '', 30), 링크: truncate(a.url ?? '', 40) })))
        );
      }
    });

  return cmd;
}

function collect(value: string, prev: string[]) {
  return [...prev, value];
}
