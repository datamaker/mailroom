import { Command } from 'commander';
import chalk from 'chalk';
import { configPath, loadConfig, saveConfig } from '../config.js';

export function loginCommand() {
  const cmd = new Command('login')
    .description('서버 주소와 API 키 저장')
    .option('--url <url>', 'mailroom 주소 (예: https://mail.datasee.co.kr)')
    .option('--key <key>', 'API 키 (워크스페이스 설정 > API 키에서 발급)')
    .action(async (opts) => {
      if (!opts.url && !opts.key) {
        const cfg = loadConfig();
        console.log(`설정 파일: ${configPath()}`);
        console.log(`주소: ${cfg.url ?? chalk.dim('(없음)')}`);
        console.log(`API 키: ${cfg.apiKey ? cfg.apiKey.slice(0, 12) + '…' : chalk.dim('(없음)')}`);
        console.log(chalk.dim('\n설정하려면: mailroom login --url https://... --key mrk_...'));
        return;
      }
      const path = saveConfig({ url: opts.url, apiKey: opts.key });
      console.log(`${chalk.green('저장됨')} ${path}`);
    });

  return cmd;
}
