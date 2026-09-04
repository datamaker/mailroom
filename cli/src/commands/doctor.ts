import { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api.js';
import { configPath, loadConfig } from '../config.js';

/** 처음 붙일 때 뭐가 잘못됐는지 한 번에 알려 준다. */
export function doctorCommand() {
  return new Command('doctor').description('연결·인증·발송 준비 상태 점검').action(async () => {
    const cfg = loadConfig();
    const ok = (s: string) => console.log(`${chalk.green('✓')} ${s}`);
    const bad = (s: string) => console.log(`${chalk.red('✗')} ${s}`);
    const warn = (s: string) => console.log(`${chalk.yellow('!')} ${s}`);

    console.log(chalk.dim(`설정 파일: ${configPath()}\n`));

    if (!cfg.url) {
      bad('주소가 설정되지 않았습니다. mailroom login --url https://... --key mrk_...');
      process.exitCode = 1;
      return;
    }
    ok(`주소 ${cfg.url}`);

    try {
      const h = await api<any>('/api/health');
      ok(`서버 응답 — 버전 ${h.version}, 발송 방식 ${h.provider}`);
    } catch (err: any) {
      bad(`서버에 닿지 못했습니다: ${err.message}`);
      console.log(chalk.dim('  사내 VPN이 켜져 있는지 확인하세요.'));
      process.exitCode = 1;
      return;
    }

    if (!cfg.apiKey) {
      bad('API 키가 없습니다. 설정 > API 키에서 발급한 뒤 mailroom login --key mrk_...');
      process.exitCode = 1;
      return;
    }

    try {
      const { lists } = await api<any>('/api/lists');
      ok(`인증됨 — 주소록 ${lists.length}개, 구독자 ${lists.reduce((a: number, l: any) => a + l.subscriber_count, 0).toLocaleString('ko-KR')}명`);
    } catch (err: any) {
      bad(`인증 실패: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    try {
      const { senders } = await api<any>('/api/senders');
      const verified = senders.filter((s: any) => s.verified);
      if (!senders.length) warn('등록된 발신자 주소가 없습니다.');
      else if (!verified.length) warn(`발신자 ${senders.length}개 모두 미인증 — 발송이 실패합니다.`);
      else ok(`발신자 ${verified.length}/${senders.length}개 인증됨 (${verified.map((s: any) => s.email).join(', ')})`);
    } catch {
      warn('발신자 상태를 확인하지 못했습니다(읽기 전용 키일 수 있습니다).');
    }

    try {
      const s = await api<any>('/api/settings');
      if (s.sendLocked) warn('발송 잠금이 켜져 있습니다 — 구독자에게 나가지 않습니다.');
      else ok(`발송 가능 — ${s.sendProvider}, 초당 ${s.rateLimit}통`);
    } catch {
      /* 권한 없는 키면 넘어간다 */
    }
  });
}
