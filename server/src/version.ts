import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** package.json 에서 읽는다. 문자열로 박아 두면 릴리스할 때 어긋난다. */
function read(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8'));
      if (pkg?.version) return pkg.version as string;
    } catch {
      /* 다음 후보 */
    }
  }
  return '0.0.0';
}

export const VERSION = read();
