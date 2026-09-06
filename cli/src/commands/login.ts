import { Command } from 'commander';
import chalk from 'chalk';
import { configPath, loadConfig, saveConfig } from '../config.js';
import { discover, pollForIdToken, startDeviceAuth, tryOpenBrowser } from '../sso.js';

export function loginCommand() {
  return new Command('login')
    .description('사내 SSO 로그인 (또는 API 키 저장)')
    .option('--url <url>', 'mailroom 주소 (예: https://mailroom.datasee.co.kr)')
    .option('--key <key>', 'API 키로 로그인 (연동·자동화용)')
    .option('--status', '지금 설정 보기')
    .action(async (opts) => {
      const cfg = loadConfig();

      if (opts.status || (!opts.url && !opts.key && cfg.url)) {
        showStatus();
        if (!opts.status) console.log(chalk.dim('\n다시 로그인: mailroom login --url <주소>'));
        return;
      }

      const url = (opts.url ?? cfg.url ?? '').replace(/\/+$/, '');
      if (!url) {
        console.log('주소가 필요합니다: mailroom login --url https://mailroom.datasee.co.kr');
        process.exitCode = 1;
        return;
      }

      // API 키를 명시하면 그대로 저장한다. 사람이 아닌 연동에 쓴다.
      if (opts.key) {
        saveConfig({ url, apiKey: opts.key, token: undefined, expiresAt: undefined, email: undefined });
        console.log(`${chalk.green('저장됨')} API 키로 접속합니다.`);
        return;
      }

      // 기본은 SSO. 브라우저에서 승인받고 세션 토큰을 받아 온다.
      const status = await fetch(`${url}/api/auth/status`)
        .then((r) => r.json() as Promise<any>)
        .catch(() => null);

      if (!status) {
        console.log(chalk.red('서버에 닿지 못했습니다.'), chalk.dim('사내 VPN이 켜져 있는지 확인하세요.'));
        process.exitCode = 1;
        return;
      }
      if (!status.sso || !status.issuer || !status.cliClientId) {
        console.log(chalk.yellow('이 서버는 SSO 로그인을 지원하지 않습니다.'));
        console.log(chalk.dim('설정 > API 키에서 발급한 뒤: mailroom login --url ' + url + ' --key mrk_...'));
        process.exitCode = 1;
        return;
      }

      const discovery = await discover(status.issuer);
      const auth = await startDeviceAuth(discovery, status.cliClientId);
      const verifyUrl = auth.verification_uri_complete ?? auth.verification_uri;

      console.log('\n브라우저에서 로그인을 승인해 주세요:\n');
      console.log(`  ${chalk.cyan(verifyUrl)}\n`);
      console.log(`  코드: ${chalk.bold(auth.user_code)}\n`);
      tryOpenBrowser(verifyUrl);
      process.stdout.write(chalk.dim('승인 대기 중…'));

      const idToken = await pollForIdToken(discovery, status.cliClientId, auth);

      const res = await fetch(`${url}/api/auth/cli/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        process.stdout.write('\n');
        console.log(chalk.red('로그인 실패:'), body?.message ?? res.statusText);
        process.exitCode = 1;
        return;
      }

      saveConfig({
        url,
        token: body.token,
        expiresAt: body.expiresAt,
        email: body.user.email,
        apiKey: undefined,
      });
      process.stdout.write('\r');
      console.log(
        `${chalk.green('✓ 로그인됨')} ${body.user.name ?? body.user.email} <${body.user.email}> (${body.user.role})`
      );
      console.log(chalk.dim(`  ${new Date(body.expiresAt).toLocaleDateString('ko-KR')} 까지 유효 · ${configPath()}`));
    });
}

export function logoutCommand() {
  return new Command('logout').description('저장된 로그인 정보 지우기').action(() => {
    saveConfig({ token: undefined, apiKey: undefined, expiresAt: undefined, email: undefined });
    console.log('로그아웃되었습니다.');
  });
}

function showStatus() {
  const cfg = loadConfig();
  console.log(`설정 파일: ${configPath()}`);
  console.log(`주소: ${cfg.url ?? chalk.dim('(없음)')}`);
  if (cfg.token) {
    const left = cfg.expiresAt ? Math.ceil((new Date(cfg.expiresAt).getTime() - Date.now()) / 86_400_000) : null;
    const expiry = left === null ? '' : left > 0 ? ` · ${left}일 남음` : chalk.red(' · 만료됨');
    console.log(`로그인: SSO ${cfg.email ?? ''}${expiry}`);
  } else if (cfg.apiKey) {
    console.log(`로그인: API 키 ${cfg.apiKey.slice(0, 12)}…`);
  } else {
    console.log(chalk.dim('로그인: (없음)'));
  }
}
