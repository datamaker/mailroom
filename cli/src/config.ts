import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface CliConfig {
  url?: string;
  apiKey?: string;
}

const CONFIG_PATH =
  process.env.MAILROOM_CONFIG ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mailroom', 'config.json');

export function loadConfig(): CliConfig {
  const fromEnv: CliConfig = {};
  if (process.env.MAILROOM_URL) fromEnv.url = process.env.MAILROOM_URL;
  if (process.env.MAILROOM_API_KEY) fromEnv.apiKey = process.env.MAILROOM_API_KEY;

  let fromFile: CliConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      /* 손상된 설정은 무시하고 env 만 쓴다 */
    }
  }
  return { ...fromFile, ...fromEnv };
}

export function saveConfig(patch: CliConfig) {
  const current = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const next = { ...current, ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  // API 키가 들어 있으니 본인만 읽게 한다.
  chmodSync(CONFIG_PATH, 0o600);
  return CONFIG_PATH;
}

export function configPath() {
  return CONFIG_PATH;
}
