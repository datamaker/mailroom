import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * package.json 에서 버전을 읽는다.
 * 문자열로 박아 두면 릴리스할 때 한쪽만 올리고 어긋난다 — 실제로 0.2.0 을 내면서
 * --version 이 0.1.0 을 그대로 출력했다.
 */
function read(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/version.js → ../package.json, 소스 실행(tsx) → ../package.json
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8'));
      if (pkg?.name === '@datasee/mailroom-cli' && pkg.version) return pkg.version;
    } catch {
      /* 다음 후보 */
    }
  }
  return '0.0.0';
}

export const VERSION = read();
