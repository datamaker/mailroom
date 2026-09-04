const env = process.env;

function bool(v: string | undefined, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(env.PORT, 9200),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || 'postgres://mailroom:mailroom@localhost:5436/mailroom',

  /** 링크·픽셀·구독폼에 박히는 공개 주소. 프로덕션에서 반드시 설정. */
  publicUrl: (env.MAILROOM_PUBLIC_URL || `http://localhost:${int(env.PORT, 9200)}`).replace(/\/$/, ''),

  /** 추적 토큰·세션 서명용. 미설정 시 부팅할 때마다 링크가 무효화된다. */
  secret: env.MAILROOM_SECRET || '',

  /** 첫 로그인 사용자를 owner로 승격시킬 이메일 목록 */
  adminEmails: (env.MAILROOM_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  oidc: {
    issuer: env.OIDC_ISSUER || '',
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
    },
  },

  /** SSO 없이 로컬에서 굴릴 때만. 프로덕션에서 켜면 인증이 통째로 열린다. */
  devAuthEmail: env.MAILROOM_DEV_AUTH_EMAIL || '',

  send: {
    provider: (env.MAILROOM_SEND_PROVIDER || 'ses') as 'ses' | 'smtp' | 'console',
    /** 초당 발송 상한. SES 계정 한도(us-east-1 = 14/s)보다 낮게 둔다. */
    rateLimit: int(env.MAILROOM_SEND_RATE, 12),
    batchSize: int(env.MAILROOM_SEND_BATCH, 200),
    ses: {
      region: env.AWS_SES_REGION || env.AWS_REGION || 'us-east-1',
      configurationSet: env.AWS_SES_CONFIGURATION_SET || '',
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      secure: bool(env.SMTP_SECURE, false),
    },
  },

  worker: {
    enabled: bool(env.MAILROOM_WORKER, true),
    pollMs: int(env.MAILROOM_WORKER_POLL_MS, 2000),
  },
} as const;

export function assertProductionConfig(log: (msg: string) => void) {
  if (!config.secret) log('MAILROOM_SECRET 미설정 — 재시작하면 추적/구독 링크가 무효화됩니다.');
  if (!config.publicUrl.startsWith('https') && process.env.NODE_ENV === 'production') {
    log(`MAILROOM_PUBLIC_URL이 https가 아닙니다: ${config.publicUrl}`);
  }
  if (!config.oidc.enabled && !config.devAuthEmail) {
    log('OIDC 미설정 — 아무도 로그인할 수 없습니다.');
  }
  if (config.devAuthEmail && process.env.NODE_ENV === 'production') {
    log(`MAILROOM_DEV_AUTH_EMAIL이 프로덕션에서 켜져 있습니다(${config.devAuthEmail}). 인증이 우회됩니다.`);
  }
}
