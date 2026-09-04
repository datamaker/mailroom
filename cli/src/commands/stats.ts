import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { json, pct, table, truncate, when } from '../format.js';

export function statsCommand() {
  const cmd = new Command('stats').description('발송 통계');

  cmd
    .command('overview')
    .description('기간별 전체 발송 통계')
    .option('--from <date>', '시작일 (YYYY-MM-DD)')
    .option('--to <date>', '종료일 (YYYY-MM-DD)')
    .option('--lists <ids>', '쉼표로 구분한 주소록 ID')
    .option('--tags <tags>', '쉼표로 구분한 태그')
    .option('--interval <unit>', 'week | month', 'week')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const res = await api<any>('/api/stats/overview', {
        query: { from: opts.from, to: opts.to, listIds: opts.lists, tags: opts.tags, interval: opts.interval },
      });
      if (opts.json) return console.log(json(res));
      const s = res.summary;
      console.log(chalk.bold(`이메일 ${s.campaigns}건`));
      console.log(
        table([
          { 지표: '발송 성공', 수: s.sent, 비율: pct(s.delivery_rate) },
          { 지표: '오픈', 수: s.opens, 비율: pct(s.open_rate) },
          { 지표: '클릭', 수: s.clicks, 비율: pct(s.click_rate) },
          { 지표: '수신거부', 수: s.unsubscribes, 비율: pct(s.unsubscribe_rate) },
        ])
      );
      if (res.series.length) {
        console.log('\n' + chalk.bold(opts.interval === 'month' ? '월별' : '주별'));
        console.log(
          table(
            res.series.map((r: any) => ({
              기간: when(r.bucket).split(' ')[0],
              발송: r.sent,
              오픈율: pct(r.open_rate),
              클릭률: pct(r.click_rate),
              수신거부: r.unsubscribes,
            }))
          )
        );
      }
    });

  cmd
    .command('dashboard')
    .description('대시보드 요약')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const res = await api<any>('/api/stats/dashboard');
      if (opts.json) return console.log(json(res));
      if (res.latest) {
        console.log(chalk.bold('최근 발송한 이메일'), res.latest.subject);
        console.log(
          table([
            { 지표: '발송 성공', 수: res.latest.sent_count, 비율: pct(res.latest.delivery_rate) },
            { 지표: '오픈', 수: res.latest.unique_open_count, 비율: pct(res.latest.open_rate) },
            { 지표: '클릭', 수: res.latest.unique_click_count, 비율: pct(res.latest.click_rate) },
            { 지표: '수신거부', 수: res.latest.unsub_count, 비율: pct(res.latest.unsubscribe_rate) },
          ])
        );
      }
      console.log(`\n구독 중 ${chalk.green(res.subscribers.subscribed)} · 수신거부 ${res.subscribers.unsubscribed}`);
      if (res.recent.length) {
        console.log('\n' + chalk.bold('최근 발송'));
        console.log(
          table(
            res.recent.map((r: any) => ({
              제목: truncate(r.subject, 40),
              발송: r.sent_count,
              오픈율: pct(r.open_rate),
              클릭률: pct(r.click_rate),
              일시: when(r.send_finished_at),
            }))
          )
        );
      }
    });

  return cmd;
}
