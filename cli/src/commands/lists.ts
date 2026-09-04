import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { json, status, table, truncate, when } from '../format.js';

export function listsCommand() {
  const cmd = new Command('lists').alias('list').description('주소록 관리');

  cmd
    .command('ls')
    .description('주소록 목록')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const { lists } = await api<{ lists: any[] }>('/api/lists');
      if (opts.json) return console.log(json(lists));
      console.log(
        table(
          lists.map((l) => ({
            ID: l.id.slice(0, 8),
            이름: truncate(l.name, 24),
            구독자: l.subscriber_count,
            수신거부: l.unsubscribed_count,
            slug: l.slug,
            최근추가: when(l.last_subscriber_at),
          }))
        )
      );
    });

  cmd
    .command('show <listId>')
    .description('주소록 상세 (필드/그룹/세그먼트 포함)')
    .option('--json', 'JSON 출력')
    .action(async (listId, opts) => {
      const [{ list, stats }, { fields }, { groups }, { segments }] = await Promise.all([
        api<any>(`/api/lists/${listId}`),
        api<any>(`/api/lists/${listId}/fields`),
        api<any>(`/api/lists/${listId}/groups`),
        api<any>(`/api/lists/${listId}/segments`),
      ]);
      if (opts.json) return console.log(json({ list, stats, fields, groups, segments }));

      console.log(chalk.bold(list.name), chalk.dim(`(${list.id})`));
      console.log(chalk.dim(`구독 폼: /s/${list.slug}`));
      console.log(
        `구독 중 ${chalk.green(stats.subscribed)} · 수신거부 ${stats.unsubscribed} · 자동삭제 ${stats.deleted}` +
          (stats.pending ? ` · 확인대기 ${stats.pending}` : '')
      );
      console.log(`발신자: ${list.default_sender_name ?? '-'} <${list.default_sender_email ?? '-'}>`);
      console.log('\n' + chalk.bold('사용자 정의 필드'));
      console.log(table(fields.map((f: any) => ({ key: f.key, 이름: f.label, 유형: f.type, 필수: f.required ? 'Y' : '' }))));
      if (groups.length) {
        console.log('\n' + chalk.bold('그룹'));
        console.log(table(groups.map((g: any) => ({ ID: g.id.slice(0, 8), 이름: g.name, 구독자: g.subscriber_count }))));
      }
      if (segments.length) {
        console.log('\n' + chalk.bold('세그먼트'));
        console.log(table(segments.map((s: any) => ({ ID: s.id.slice(0, 8), 이름: s.name, 대상: s.subscriber_count }))));
      }
    });

  cmd
    .command('create <name>')
    .description('주소록 만들기')
    .option('--sender-name <name>', '기본 발신자 이름')
    .option('--sender-email <email>', '기본 발신자 이메일')
    .option('--company <name>', '푸터 회사명')
    .option('--address <address>', '푸터 주소')
    .option('--phone <phone>', '푸터 전화번호')
    .option('--no-double-optin', '구독 확인 이메일 없이 바로 구독 처리')
    .action(async (name, opts) => {
      const { list } = await api<any>('/api/lists', {
        method: 'POST',
        body: {
          name,
          default_sender_name: opts.senderName,
          default_sender_email: opts.senderEmail,
          footer_company: opts.company,
          footer_address: opts.address,
          footer_phone: opts.phone,
          double_optin: opts.doubleOptin,
        },
      });
      console.log(`${chalk.green('생성됨')} ${list.name} ${chalk.dim(list.id)}`);
    });

  cmd
    .command('groups <listId>')
    .description('그룹 목록')
    .action(async (listId) => {
      const { groups } = await api<any>(`/api/lists/${listId}/groups`);
      console.log(table(groups.map((g: any) => ({ ID: g.id, 이름: g.name, 구독자: g.subscriber_count }))));
    });

  cmd
    .command('add-group <listId> <name>')
    .description('그룹 만들기')
    .action(async (listId, name) => {
      const { group } = await api<any>(`/api/lists/${listId}/groups`, { method: 'POST', body: { name } });
      console.log(`${chalk.green('생성됨')} ${group.name} ${chalk.dim(group.id)}`);
    });

  cmd
    .command('segments <listId>')
    .description('세그먼트 목록')
    .action(async (listId) => {
      const { segments } = await api<any>(`/api/lists/${listId}/segments`);
      console.log(
        table(segments.map((s: any) => ({ ID: s.id, 이름: s.name, 조건: s.match, 대상: s.subscriber_count })))
      );
    });

  cmd
    .command('add-segment <listId> <name>')
    .description('세그먼트 만들기 (조건은 JSON 배열)')
    .requiredOption('--conditions <json>', '예: \'[{"type":"field","key":"company","op":"contains","value":"대학교"}]\'')
    .option('--match <mode>', 'all | any', 'all')
    .action(async (listId, name, opts) => {
      const { segment } = await api<any>(`/api/lists/${listId}/segments`, {
        method: 'POST',
        body: { name, match: opts.match, conditions: JSON.parse(opts.conditions) },
      });
      const { count } = await api<any>(`/api/lists/${listId}/audience/count`, {
        method: 'POST',
        body: { segmentIds: [segment.id] },
      });
      console.log(`${chalk.green('생성됨')} ${segment.name} ${chalk.dim(segment.id)} — 대상 ${count}명`);
    });

  cmd
    .command('count <listId>')
    .description('조건에 걸리는 구독자 수 미리보기')
    .option('--groups <ids>', '쉼표로 구분한 그룹 ID')
    .option('--segments <ids>', '쉼표로 구분한 세그먼트 ID')
    .option('--ad-only', '광고 수신 동의자만')
    .action(async (listId, opts) => {
      const { count } = await api<any>(`/api/lists/${listId}/audience/count`, {
        method: 'POST',
        body: {
          groupIds: opts.groups?.split(','),
          segmentIds: opts.segments?.split(','),
          adAgreedOnly: opts.adOnly,
        },
      });
      console.log(`${count}명`);
    });

  return cmd;
}
