import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { json, status, table, truncate, when } from '../format.js';
import { markdownToBlocks, wrapNewsletter } from '../markdown.js';

/**
 * 자동 이메일: 조건이 맞는 사람에게 한 명씩 나가는 메일.
 * 켜는 시점 이후에 일어난 일에만 반응하므로, 켜자마자 기존 구독자 전원에게
 * 나가는 일은 없다.
 */
export function automationsCommand() {
  const cmd = new Command('automations').alias('auto').description('자동 이메일');

  cmd
    .command('ls')
    .description('자동 이메일 목록')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const r = await api<any>('/api/campaigns', { query: { limit: 100 } });
      const autos = r.campaigns.filter((c: any) => c.type === 'automation');
      if (opts.json) return console.log(json(autos));
      if (!autos.length) return console.log(chalk.dim('자동 이메일이 없습니다.'));
      console.log(
        table(
          autos.map((c: any) => ({
            ID: c.id.slice(0, 8),
            제목: truncate(c.subject, 32),
            상태: status(c.status),
            주소록: truncate(c.list_name ?? '-', 14),
            발송: c.sent_count,
          }))
        )
      );
    });

  cmd
    .command('triggers')
    .description('쓸 수 있는 발동 조건')
    .action(async () => {
      const { triggers } = await api<any>('/api/automations/triggers');
      console.log(table(triggers.map((t: any) => ({ type: t.type, 설명: t.label }))));
      console.log(chalk.dim('\n예) --trigger \'{"type":"subscribe","delayMinutes":0}\''));
      console.log(chalk.dim('    --trigger \'{"type":"campaign_not_opened","campaignId":"<id>","delayMinutes":4320}\''));
    });

  cmd
    .command('create')
    .description('자동 이메일 만들기 (아직 켜지지 않음)')
    .requiredOption('--list <listId>', '주소록 ID')
    .requiredOption('--subject <subject>', '제목')
    .requiredOption('--trigger <json>', '발동 조건 JSON')
    .option('--markdown <file>', '본문 마크다운 파일')
    .option('--blocks <file>', '블록 JSON 파일')
    .option('--sender-name <name>')
    .option('--sender-email <email>')
    .action(async (opts) => {
      const content = opts.blocks
        ? JSON.parse(readFileSync(opts.blocks, 'utf8'))
        : wrapNewsletter(markdownToBlocks(readFileSync(opts.markdown, 'utf8')));
      const { campaign } = await api<any>('/api/campaigns', {
        method: 'POST',
        body: {
          list_id: opts.list,
          subject: opts.subject,
          sender_name: opts.senderName,
          sender_email: opts.senderEmail,
          content,
        },
      });
      await api(`/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        body: { type: 'automation', trigger: JSON.parse(opts.trigger) },
      });
      console.log(`${chalk.green('생성됨')} ${campaign.subject} ${chalk.dim(campaign.id)}`);
      console.log(chalk.dim(`켜려면: mailroom auto on ${campaign.id}`));
    });

  cmd
    .command('on <id>')
    .description('자동 이메일 켜기')
    .action(async (id) => {
      const r = await api<any>(`/api/campaigns/${id}/activate`, { method: 'POST' });
      console.log(
        `${chalk.green('켜짐')} — 지금 예약된 발송 ${r.scheduled}건\n` +
          chalk.dim('  켠 시점 이후에 조건이 맞는 사람에게만 나갑니다.')
      );
    });

  cmd
    .command('off <id>')
    .description('자동 이메일 끄기')
    .action(async (id) => {
      await api(`/api/campaigns/${id}/deactivate`, { method: 'POST' });
      console.log(chalk.yellow('꺼짐'));
    });

  cmd
    .command('runs <id>')
    .description('실행 현황')
    .option('-n, --limit <n>', '개수', '20')
    .action(async (id, opts) => {
      const r = await api<any>(`/api/campaigns/${id}/runs`, { query: { limit: opts.limit } });
      const s = r.summary;
      console.log(`예약 ${s.scheduled} · 발송 ${chalk.green(s.sent)} · 건너뜀 ${s.skipped} · 실패 ${chalk.red(s.failed)}`);
      if (r.runs.length) {
        console.log(
          table(
            r.runs.map((x: any) => ({
              이메일: truncate(x.email ?? '(삭제됨)', 32),
              상태: x.status,
              예정: when(x.scheduled_at),
              발송: when(x.sent_at),
              사유: truncate(x.error ?? '', 24),
            }))
          )
        );
      }
    });

  return cmd;
}
