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

  /** 링크·픽셀·구독폼에 박히는 공개 주소. 구독자가 여는 주소라 인터넷에서 열려야 한다. */
  publicUrl: (env.MAILROOM_PUBLIC_URL || `http://localhost:${int(env.PORT, 9200)}`).replace(/\/$/, ''),

  /**
   * 관리 UI 주소. SSO 리다이렉트와 로그인 후 이동에 쓴다.
   * 공개 주소와 나누는 이유: 관리 화면은 VPN 뒤에 두고 추적 링크만 공개하기 때문에
   * OIDC 콜백을 공개 도메인으로 잡으면 그쪽 vhost 에서 404 가 난다.
   */
  adminUrl: (env.MAILROOM_ADMIN_URL || env.MAILROOM_PUBLIC_URL || `http://localhost:${int(env.PORT, 9200)}`).replace(
    /\/$/,
    ''
  ),

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

    /**
     * 발송 잠금. 켜져 있으면 구독자에게 나가는 모든 메일이 막힌다.
     * 이관 직후처럼 실제 주소록이 들어와 있는데 아직 보낼 준비가 안 된 상태에서
     * 실수로 나가는 것을 막는 안전장치다. allowedRecipients 에 적은 주소로만
     * (테스트 발송 등) 나갈 수 있다.
     */
    lock: bool(env.MAILROOM_SEND_LOCK, false),
    allowedRecipients: (env.MAILROOM_ALLOWED_RECIPIENTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
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
    /** 자동 이메일 조건 스캔 주기. 초 단위 정확도가 필요한 일이 아니다. */
    automationPollMs: int(env.MAILROOM_AUTOMATION_POLL_MS, 60_000),
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
