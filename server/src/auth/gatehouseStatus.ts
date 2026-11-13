import { config } from '../config.js';

/**
 * gatehouse(사내 SSO) 계정 상태 조회 — 회수 전파.
 *
 * 우리 세션은 gatehouse 와 따로 산다. 그래서 gatehouse 에서 사용자를 비활성화하거나
 * "세션 종료"를 눌러도 여기 세션은 만료될 때까지 살아 있었다. SSO 로 만든 세션을
 * 검증할 때마다 gatehouse 에 "이 사람 아직 유효한가"를 물어(60초 캐시) 1분 안에 끊는다.
 *
 *   GET {GATEHOUSE_STATUS_URL}/internal/account?email=…   헤더 X-Gatehouse-Secret
 *   200 {"active":true,"revoked_before":"…"|null} / 404 {"active":false}
 *
 * GATEHOUSE_STATUS_URL·GATEHOUSE_STATUS_SECRET 중 하나라도 없으면 꺼진다(셀프호스트·개발).
 * gatehouse 에 닿지 않으면 마지막으로 성공한 답을 쓰고, 한 번도 성공한 적이 없으면
 * 통과시킨다 — gatehouse 장애가 메일룸 장애로 번지지 않게.
 */

export type GatehouseVerdict = 'ok' | 'inactive' | 'revoked';

export interface GatehouseStatusOptions {
  url?: string;
  secret?: string;
  /** 테스트에서 갈아 끼운다. */
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (msg: string) => void;
  cacheMs?: number;
  timeoutMs?: number;
}

interface Account {
  active: boolean;
  revokedBefore: number | null;
}

interface Entry {
  /** 마지막으로 성공한 답. 한 번도 성공하지 못했으면 null. */
  account: Account | null;
  /** 이 시각 전에는 다시 묻지 않는다. */
  nextAt: number;
  inflight: Promise<void> | null;
}

/** 조회에 실패했을 때 다시 물어보기까지의 간격. 장애 중에 요청마다 2초씩 기다리지 않게 한다. */
const RETRY_AFTER_FAILURE_MS = 10_000;
const WARN_EVERY_MS = 60_000;

export function createGatehouseStatus(opts: GatehouseStatusOptions = {}) {
  const base = (opts.url ?? '').replace(/\/+$/, '');
  const secret = opts.secret ?? '';
  const enabled = Boolean(base && secret);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const cacheMs = opts.cacheMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const cache = new Map<string, Entry>();
  let lastWarnAt = -Infinity;

  function warnOnce(msg: string) {
    if (now() - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = now();
    warn(`[gatehouse] 계정 상태 조회 실패 — 마지막으로 확인된 상태로 진행합니다: ${msg}`);
  }

  async function refresh(email: string, entry: Entry) {
    try {
      const res = await doFetch(`${base}/internal/account?email=${encodeURIComponent(email)}`, {
        headers: { 'x-gatehouse-secret': secret, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) {
        // 모르는 이메일 = 비활성으로 취급한다(계약).
        entry.account = { active: false, revokedBefore: null };
      } else if (res.status === 200) {
        const body = (await res.json()) as { active?: unknown; revoked_before?: unknown };
        const at = typeof body.revoked_before === 'string' ? Date.parse(body.revoked_before) : NaN;
        entry.account = { active: body.active === true, revokedBefore: Number.isFinite(at) ? at : null };
      } else {
        // 401(시크릿 불일치)·5xx 는 "모른다"이다 — 비활성으로 단정하지 않는다.
        throw new Error(`HTTP ${res.status}`);
      }
      entry.nextAt = now() + cacheMs;
    } catch (err) {
      entry.nextAt = now() + Math.min(cacheMs, RETRY_AFTER_FAILURE_MS);
      warnOnce((err as Error).message);
    }
  }

  return {
    enabled,

    /**
     * 이 이메일의 세션(발급 시각 issuedAt)을 계속 받아도 되는가.
     *   'inactive' — 비활성화됐거나 gatehouse 가 모르는 계정. 로컬 세션을 전부 지워야 한다.
     *   'revoked'  — 이 세션은 "세션 종료" 이전에 발급됐다. 이 세션만 무효다.
     */
    async check(rawEmail: string, issuedAt: Date | number): Promise<GatehouseVerdict> {
      if (!enabled) return 'ok';
      const email = rawEmail.trim().toLowerCase();
      let entry = cache.get(email);
      if (!entry) {
        entry = { account: null, nextAt: 0, inflight: null };
        cache.set(email, entry);
      }
      if (now() >= entry.nextAt) {
        // 같은 이메일로 동시에 들어온 요청은 조회 하나를 같이 기다린다.
        entry.inflight ??= refresh(email, entry).finally(() => {
          entry!.inflight = null;
        });
        await entry.inflight;
      }
      const account = entry.account;
      if (!account) return 'ok'; // 한 번도 성공한 적이 없다 — 통과
      if (!account.active) return 'inactive';
      const issued = typeof issuedAt === 'number' ? issuedAt : issuedAt.getTime();
      if (account.revokedBefore !== null && issued < account.revokedBefore) return 'revoked';
      return 'ok';
    },
  };
}

export type GatehouseStatus = ReturnType<typeof createGatehouseStatus>;

let current: GatehouseStatus = createGatehouseStatus({
  url: config.gatehouse.statusUrl,
  secret: config.gatehouse.statusSecret,
});

export function gatehouseStatus(): GatehouseStatus {
  return current;
}

/** 테스트가 가짜 fetch 를 끼운 인스턴스로 바꿔 넣는다. 인자 없이 부르면 환경변수 기준으로 되돌린다. */
export function configureGatehouseStatus(opts?: GatehouseStatusOptions) {
  current = createGatehouseStatus(
    opts ?? { url: config.gatehouse.statusUrl, secret: config.gatehouse.statusSecret }
  );
}
