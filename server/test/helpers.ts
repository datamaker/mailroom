/**
 * 테스트 공통 준비. 설정(config)은 import 시점에 환경변수를 읽으므로,
 * 앱 모듈은 여기서 환경을 고정한 뒤에 동적으로 불러온다.
 */
const TEST_DB = process.env.MAILROOM_TEST_DATABASE_URL || 'postgres://mailroom:mailroom@localhost:5436/mailroom_test';

// 개발·운영 DB 에 대고 돌리는 사고를 막는다 — 이름이 _test 로 끝나는 DB 만 쓴다.
if (!/_test$/.test(new URL(TEST_DB).pathname)) {
  throw new Error(`테스트 DB 이름은 _test 로 끝나야 합니다: ${new URL(TEST_DB).pathname}`);
}

Object.assign(process.env, {
  DATABASE_URL: TEST_DB,
  MAILROOM_SECRET: 'test-secret',
  MAILROOM_PUBLIC_URL: 'http://localhost:9200',
  MAILROOM_ADMIN_URL: 'http://localhost:9200',
  MAILROOM_SEND_PROVIDER: 'console',
  MAILROOM_WORKER: '0',
  // 인증 우회가 켜져 있으면 인증 테스트가 전부 무의미해진다.
  MAILROOM_DEV_AUTH_EMAIL: '',
  MAILROOM_SNS_TOPIC_ARNS: '',
  MAILROOM_ALERT_WEBHOOK: '',
  OIDC_ISSUER: '',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
});

import type { BuildAppOptions } from '../src/app.js';

let migrated = false;

export async function makeApp(opts: BuildAppOptions = {}) {
  const { buildApp } = await import('../src/app.js');
  if (!migrated) {
    const { migrate } = await import('../src/db/migrate.js');
    await migrate();
    migrated = true;
  }
  const app = await buildApp({ logger: false, ...opts });
  await app.ready();
  return app;
}

export async function db() {
  return import('../src/db/pool.js');
}

export async function closeDb() {
  const { pool } = await import('../src/db/pool.js');
  await pool.end();
}
