import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { json, pct, status, table, truncate, when } from '../format.js';
import { markdownToBlocks, wrapNewsletter } from '../markdown.js';

export function campaignsCommand() {
  const cmd = new Command('campaigns').alias('emails').description('이메일 작성·발송');

  cmd
    .command('ls')
    .description('이메일 목록')
    .option('--status <status>', 'draft | scheduled | sending | sent | all', 'all')
    .option('--list <listId>', '주소록으로 필터')
    .option('--tag <tag>', '태그로 필터')
    .option('-n, --limit <n>', '개수', '20')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const res = await api<any>('/api/campaigns', {
        query: { status: opts.status, listId: opts.list, tag: opts.tag, limit: opts.limit },
      });
      if (opts.json) return console.log(json(res));
      console.log(
        table(
          res.campaigns.map((c: any) => ({
            ID: c.id.slice(0, 8),
            제목: truncate(c.subject || '(제목 없음)', 40),
            상태: status(c.status),
            주소록: truncate(c.list_name ?? '-', 14),
            발송: c.sent_count || '',
            오픈율: c.sent_count ? pct(round(c.unique_open_count, c.sent_count)) : '',
            클릭률: c.sent_count ? pct(round(c.unique_click_count, c.sent_count)) : '',
            일시: when(c.send_finished_at ?? c.scheduled_at ?? c.updated_at),
          }))
        )
      );
    });

  cmd
    .command('show <id>')
    .description('이메일 상세')
    .option('--json', 'JSON 출력')
    .action(async (id, opts) => {
      const { campaign } = await api<any>(`/api/campaigns/${id}`);
      if (opts.json) return console.log(json(campaign));
      console.log(chalk.bold(campaign.subject), status(campaign.status));
      console.log(chalk.dim(campaign.id));
      console.log(`주소록: ${campaign.list_name ?? '-'}`);
      console.log(`발신자: ${campaign.sender_name ?? '-'} <${campaign.sender_email ?? '-'}>`);
      console.log(`상자 ${campaign.content?.length ?? 0}개 · 태그 ${(campaign.tags ?? []).join(',') || '-'}`);
      if (campaign.scheduled_at) console.log(`예약: ${when(campaign.scheduled_at)}`);
      if (campaign.public_slug) console.log(`웹에서 보기: /w/${campaign.public_slug}`);
    });

  cmd
    .command('create')
    .description('이메일 만들기 (마크다운 또는 블록 JSON에서)')
    .requiredOption('--list <listId>', '주소록 ID')
    .requiredOption('--subject <subject>', '제목')
    .option('--markdown <file>', '마크다운 파일로 본문 작성')
    .option('--blocks <file>', '블록 JSON 파일')
    .option('--sender-name <name>', '발신자 이름 (기본값은 주소록 설정)')
    .option('--sender-email <email>', '발신자 이메일')
    .option('--reply-to <email>', '회신 주소')
    .option('--tags <tags>', '쉼표로 구분한 태그')
    .option('--ad', '광고성 이메일 (제목에 (광고) 자동 표기)')
    .option('--no-footer', '푸터 상자를 넣지 않음')
    .option('--json', 'JSON 출력')
    .action(async (opts) => {
      const content = buildContent(opts);
      const { campaign } = await api<any>('/api/campaigns', {
        method: 'POST',
        body: {
          list_id: opts.list,
          subject: opts.subject,
          sender_name: opts.senderName,
          sender_email: opts.senderEmail,
          reply_to: opts.replyTo,
          tags: opts.tags?.split(','),
          is_ad: Boolean(opts.ad),
          content,
        },
      });
      if (opts.json) return console.log(json(campaign));
      console.log(`${chalk.green('생성됨')} ${campaign.subject} ${chalk.dim(campaign.id)} — 상자 ${content.length}개`);
    });

  cmd
    .command('content <id>')
    .description('본문 교체 (마크다운 또는 블록 JSON)')
    .option('--markdown <file>', '마크다운 파일')
    .option('--blocks <file>', '블록 JSON 파일')
    .option('--no-footer', '푸터 상자를 넣지 않음')
    .action(async (id, opts) => {
      const content = buildContent(opts);
      await api(`/api/campaigns/${id}`, { method: 'PATCH', body: { content } });
      console.log(`${chalk.green('갱신됨')} 상자 ${content.length}개`);
    });

  cmd
    .command('target <id>')
    .description('발송 대상 설정')
    .option('--groups <ids>', '쉼표로 구분한 그룹 ID')
    .option('--segments <ids>', '쉼표로 구분한 세그먼트 ID')
    .option('--ad-only', '광고 수신 동의자만')
    .action(async (id, opts) => {
      await api(`/api/campaigns/${id}`, {
        method: 'PATCH',
        body: {
          target: {
            groupIds: opts.groups?.split(','),
            segmentIds: opts.segments?.split(','),
            adAgreedOnly: Boolean(opts.adOnly),
          },
        },
      });
      const res = await api<any>(`/api/campaigns/${id}/audience`);
      console.log(`발송 대상 ${chalk.bold(res.count)}명`);
    });

  cmd
    .command('preview <id> [outFile]')
    .description('렌더된 HTML 보기 (파일로 저장 가능)')
    .option('--sample', '머지태그에 샘플 값 채우기')
    .option('--web', '웹 게시용으로 렌더')
    .action(async (id, outFile, opts) => {
      const res = await api<any>(`/api/campaigns/${id}/html`, {
        query: { sample: opts.sample ? '1' : undefined, mode: opts.web ? 'web' : 'email' },
      });
      if (outFile) {
        writeFileSync(outFile, res.html);
        console.log(`${chalk.green('저장됨')} ${outFile} (${res.html.length} bytes)`);
      } else {
        process.stdout.write(res.html);
      }
    });

  cmd
    .command('check <id>')
    .description('발송 전 점검')
    .action(async (id) => {
      const res = await api<any>(`/api/campaigns/${id}/audience`);
      console.log(`발송 대상 ${chalk.bold(res.count)}명`);
      if (!res.issues.length) return console.log(chalk.green('문제 없음'));
      for (const issue of res.issues) console.log(chalk.yellow(`  ! ${issue}`));
    });

  cmd
    .command('test <id>')
    .description('테스트 발송 (최대 5명)')
    .requiredOption('-e, --emails <emails>', '쉼표로 구분한 수신자')
    .action(async (id, opts) => {
      const res = await api<any>(`/api/campaigns/${id}/test`, {
        method: 'POST',
        body: { recipients: opts.emails.split(',') },
      });
      for (const r of res.results) {
        console.log(r.ok ? `${chalk.green('발송')} ${r.email}` : `${chalk.red('실패')} ${r.email}: ${r.error}`);
      }
    });

  cmd
    .command('send <id>')
    .description('지금 발송')
    .option('-y, --yes', '확인 없이 발송')
    .action(async (id, opts) => {
      const pre = await api<any>(`/api/campaigns/${id}/audience`);
      if (!opts.yes) {
        const { campaign } = await api<any>(`/api/campaigns/${id}`);
        console.log(`제목: ${campaign.subject}`);
        console.log(`대상: ${pre.count}명`);
        for (const issue of pre.issues) console.log(chalk.yellow(`  ! ${issue}`));
        console.log(chalk.dim('실제로 보내려면 --yes 를 붙이세요.'));
        return;
      }
      const res = await api<any>(`/api/campaigns/${id}/send`, { method: 'POST' });
      console.log(`${chalk.green('발송 시작')} 대상 ${pre.count}명 · 상태 ${res.campaign.status}`);
    });

  cmd
    .command('schedule <id> <when>')
    .description('예약 발송 (ISO 8601 또는 "2026-09-05 07:00")')
    .action(async (id, whenArg) => {
      const iso = new Date(whenArg.replace(' ', 'T')).toISOString();
      const res = await api<any>(`/api/campaigns/${id}/schedule`, {
        method: 'POST',
        body: { scheduled_at: iso },
      });
      console.log(`${chalk.green('예약됨')} ${when(res.campaign.scheduled_at)}`);
    });

  cmd.command('pause <id>').description('발송 일시중지').action(async (id) => {
    await api(`/api/campaigns/${id}/pause`, { method: 'POST' });
    console.log(chalk.yellow('일시중지됨'));
  });

  cmd.command('resume <id>').description('발송 재개').action(async (id) => {
    await api(`/api/campaigns/${id}/resume`, { method: 'POST' });
    console.log(chalk.green('재개됨'));
  });

  cmd.command('cancel <id>').description('예약/일시중지된 발송 취소').action(async (id) => {
    await api(`/api/campaigns/${id}/cancel`, { method: 'POST' });
    console.log('취소됨');
  });

  cmd.command('duplicate <id>').description('복사하기').action(async (id) => {
    const { campaign } = await api<any>(`/api/campaigns/${id}/duplicate`, { method: 'POST' });
    console.log(`${chalk.green('복사됨')} ${chalk.dim(campaign.id)}`);
  });

  cmd
    .command('stats <id>')
    .description('발송 통계')
    .option('--json', 'JSON 출력')
    .action(async (id, opts) => {
      const s = await api<any>(`/api/campaigns/${id}/stats`);
      if (opts.json) return console.log(json(s));
      const t = s.totals;
      console.log(chalk.bold(s.campaign.subject), status(s.campaign.status));
      console.log(chalk.dim(`${when(s.campaign.send_started_at)} ~ ${when(s.campaign.send_finished_at)}`));
      console.log();
      console.log(
        table([
          { 지표: '발송 성공', 수: t.sent, 비율: pct(t.delivery_rate) },
          { 지표: '오픈', 수: t.unique_opens, 비율: pct(t.open_rate) },
          { 지표: '클릭', 수: t.unique_clicks, 비율: pct(t.click_rate) },
          { 지표: '수신거부', 수: t.unsubscribes, 비율: pct(t.unsubscribe_rate) },
          { 지표: '바운스', 수: t.bounced, 비율: pct(t.bounce_rate) },
          { 지표: '실패', 수: t.failed, 비율: '' },
        ])
      );
      if (s.links.length) {
        console.log('\n' + chalk.bold('많이 클릭한 링크'));
        console.log(table(s.links.slice(0, 5).map((l: any) => ({ 링크: truncate(l.url, 60), 클릭: l.click_count }))));
      }
      if (s.devices.length) {
        const total = s.devices.reduce((a: number, d: any) => a + d.count, 0) || 1;
        const byDevice: Record<string, number> = {};
        for (const d of s.devices) byDevice[d.device] = (byDevice[d.device] ?? 0) + d.count;
        console.log('\n' + chalk.bold('오픈 환경'));
        console.log(
          table(
            Object.entries(byDevice).map(([k, v]) => ({
              구분: k,
              오픈: v,
              비율: pct(Math.round((v / total) * 1000) / 10),
            }))
          )
        );
      }
    });

  cmd
    .command('recipients <id>')
    .description('수신자별 발송 결과')
    .option('--event <event>', 'opened | clicked | not_opened')
    .option('--status <status>', 'sent | failed | bounced')
    .option('-n, --limit <n>', '개수', '30')
    .action(async (id, opts) => {
      const res = await api<any>(`/api/campaigns/${id}/recipients`, {
        query: { event: opts.event, status: opts.status, limit: opts.limit },
      });
      console.log(chalk.dim(`${res.total}명 중 ${res.recipients.length}명`));
      console.log(
        table(
          res.recipients.map((r: any) => ({
            이메일: truncate(r.email, 32),
            상태: status(r.status),
            오픈: r.open_count || '',
            클릭: r.click_count || '',
            발송시각: when(r.sent_at),
            오류: truncate(r.error ?? '', 30),
          }))
        )
      );
    });

  return cmd;
}

function buildContent(opts: { markdown?: string; blocks?: string; footer?: boolean }) {
  if (opts.blocks) return JSON.parse(readFileSync(opts.blocks, 'utf8'));
  if (opts.markdown) {
    const md = opts.markdown === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.markdown, 'utf8');
    return wrapNewsletter(markdownToBlocks(md), { footer: opts.footer !== false });
  }
  throw new Error('--markdown 또는 --blocks 중 하나가 필요합니다.');
}

function round(part: number, whole: number) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
