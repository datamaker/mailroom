import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { closeDb, db, makeApp } from './helpers.js';

/**
 * 2026-11 보안 점검 회귀 테스트.
 * 머지태그 주입, 구독폼의 기존 구독자 덮어쓰기, 웹뷰 스크립트, 링크 점검 SSRF,
 * 클릭 추적 열거, 세션 회수(gatehouse), OIDC state 바인딩, 권한 값 검증, 내보내기 감사.
 */

const PUBLIC = 'http://localhost:9200';
const ADMIN = 'http://admin.localhost:9200';
const run = `sec${Date.now().toString(36)}`;

let ipSeq = 0;
/** 구독 신청 제한(IP 당 시간당 20회)에 걸리지 않게 요청마다 다른 주소를 쓴다. */
const freshIp = () => `198.51.100.${++ipSeq}`;

describe('머지태그 치환', () => {
  it('HTML 본문에서는 구독자 값을 이스케이프한다', async () => {
    const { mergeTags } = await import('../src/render/merge.js');
    const out = mergeTags(
      '<p>안녕하세요 $%name%$ 님</p><a href="https://x.test/?c=$%company%$">링크</a>',
      { fields: { name: '<img src=x onerror=alert(1)>', company: '"><script>alert(1)</script>' } },
      'html'
    );
    assert.ok(!out.includes('<img'));
    assert.ok(!out.includes('<script>'));
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
    // 속성 안에서도 따옴표를 닫고 나올 수 없다.
    assert.ok(out.includes('href="https://x.test/?c=&quot;&gt;&lt;script&gt;'));
  });

  it('필드 기본값도 값으로 다룬다(이스케이프)', async () => {
    const { mergeTags } = await import('../src/render/merge.js');
    const out = mergeTags('$%name%$', { fields: {}, defaults: { name: '<b>고객</b>' } }, 'html');
    assert.equal(out, '&lt;b&gt;고객&lt;/b&gt;');
  });

  it('서버가 만든 링크는 그대로 넣는다(이중 이스케이프 없음)', async () => {
    const { mergeTags } = await import('../src/render/merge.js');
    const url = 'https://m.test/u/uabc.sig?a=1&b=2';
    const out = mergeTags(
      '<a href="$%unsubscribe%$">x</a> $%preferences%$ $%permalink%$',
      { fields: {}, links: { unsubscribe: url, preferences: 'https://m.test/p/1', webview: 'https://m.test/w/s' } },
      'html'
    );
    assert.equal(out, `<a href="${url}">x</a> https://m.test/p/1 https://m.test/w/s`);
  });

  it('제목·텍스트에서는 이스케이프하지 않고 줄바꿈·제어문자를 지운다', async () => {
    const { mergeTags } = await import('../src/render/merge.js');
    const out = mergeTags(
      '[$%name%$] 소식',
      { fields: { name: 'A&B\r\nBcc: victim@example.com\u0000\u2028끝' } },
      'text'
    );
    assert.equal(out, '[A&B Bcc: victim@example.com 끝] 소식');
    assert.ok(!/[\r\n\u0000\u2028]/.test(out));
  });

  it('발송 경로: 구독자 필드의 마크업이 실제 메일 본문·제목에 살아서 나가지 않는다', async () => {
    const { mergeTags } = await import('../src/render/merge.js');
    const src = { fields: { name: '<a href="https://evil.test">당첨</a>\r\nX-Injected: 1', email: 'a@b.co' } };
    const html = mergeTags('<p>$%name%$</p>', src, 'html');
    const subject = mergeTags('$%name%$ 님께', src, 'text');
    assert.ok(!html.includes('<a href'));
    assert.ok(!subject.includes('\n') && !subject.includes('\r'));
  });
});

describe('링크 점검 SSRF', () => {
  it('내부·특수 주소를 공인 주소로 보지 않는다', async () => {
    const { isPublicAddress } = await import('../src/lib/safe-fetch.js');
    const blocked = [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '198.18.0.1', '192.0.2.1',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
      '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
      'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1',
      'fd00:ec2::254', 'not-an-ip', '',
    ];
    for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
    const allowed = [
      '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1',
      '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001::200e',
    ];
    for (const ip of allowed) assert.equal(isPublicAddress(ip), true, ip);
  });

  const dnsTable: Record<string, string[]> = {
    'ok.test': ['93.184.216.34'],
    'internal.test': ['10.0.0.5'],
    'mixed.test': ['93.184.216.34', '127.0.0.1'],
    'mapped.test': ['::ffff:169.254.169.254'],
  };
  const resolve = async (host: string) => dnsTable[host] ?? [];

  it('내부 주소로 풀리는 이름은 요청하지 않는다', async () => {
    const { probeUrl, BlockedAddressError } = await import('../src/lib/safe-fetch.js');
    for (const url of [
      'http://internal.test/',
      'http://mixed.test/',
      'http://mapped.test/',
      'http://127.0.0.1:5436/',
      'http://2130706433/', // 십진수 표기 127.0.0.1
      'http://0x7f.1/',
      'http://[::1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://user:pw@ok.test/',
    ]) {
      const calls: string[] = [];
      await assert.rejects(
        probeUrl(url, { resolve, request: async (u) => (calls.push(u.href), { status: 200 }) }),
        BlockedAddressError,
        url
      );
      assert.deepEqual(calls, [], `${url} 로 요청이 나가면 안 된다`);
    }
  });

  it('리다이렉트 홉마다 다시 검사한다 — 공인 주소가 내부로 넘기면 따라가지 않는다', async () => {
    const { probeUrl, BlockedAddressError } = await import('../src/lib/safe-fetch.js');
    const calls: string[] = [];
    const request = async (u: URL, _m: string, address: string) => {
      calls.push(`${u.href} via ${address}`);
      return { status: 302, location: 'http://169.254.169.254/latest/meta-data/' };
    };
    await assert.rejects(probeUrl('http://ok.test/a', { resolve, request }), BlockedAddressError);
    assert.deepEqual(calls, ['http://ok.test/a via 93.184.216.34']);

    // 이름으로 넘겨도 마찬가지다.
    calls.length = 0;
    const toName = async (u: URL) => (calls.push(u.href), { status: 301, location: '//internal.test/x' });
    await assert.rejects(probeUrl('http://ok.test/a', { resolve, request: toName }), BlockedAddressError);
    assert.deepEqual(calls, ['http://ok.test/a']);
  });

  it('공인 주소끼리의 리다이렉트는 따라가고, 검사한 주소로 연결한다', async () => {
    const { probeUrl } = await import('../src/lib/safe-fetch.js');
    const seen: string[] = [];
    const request = async (u: URL, method: string, address: string) => {
      seen.push(`${method} ${u.pathname} ${address}`);
      if (u.pathname === '/a') return { status: 302, location: '/b' };
      if (method === 'HEAD') return { status: 405 };
      return { status: 200 };
    };
    assert.equal(await probeUrl('http://ok.test/a', { resolve, request }), 200);
    assert.deepEqual(seen, ['HEAD /a 93.184.216.34', 'HEAD /b 93.184.216.34', 'GET /b 93.184.216.34']);
  });

  it('리다이렉트가 끝없이 이어지면 끊는다', async () => {
    const { probeUrl } = await import('../src/lib/safe-fetch.js');
    let n = 0;
    const request = async () => ({ status: 302, location: `/r${++n}` });
    await assert.rejects(probeUrl('http://ok.test/', { resolve, request, maxRedirects: 3 }), /리다이렉트/);
    assert.equal(n, 4);
  });
});

describe('gatehouse 계정 상태 조회', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function harness(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; secret: string | null }> = [];
    const warnings: string[] = [];
    let t = 1_000_000;
    return {
      calls,
      warnings,
      advance: (ms: number) => (t += ms),
      async make() {
        const { createGatehouseStatus } = await import('../src/auth/gatehouseStatus.js');
        return createGatehouseStatus({
          url: 'https://auth.test/',
          secret: 's3cret',
          now: () => t,
          warn: (m) => warnings.push(m),
          fetch: (async (url: any, init: any) => {
            calls.push({ url: String(url), secret: new Headers(init?.headers).get('x-gatehouse-secret') });
            return handler(String(url), init);
          }) as typeof fetch,
        });
      },
    };
  }

  it('URL·시크릿 중 하나라도 없으면 꺼진다', async () => {
    const { createGatehouseStatus } = await import('../src/auth/gatehouseStatus.js');
    let called = 0;
    const f = (async () => (called++, json(200, { active: false }))) as unknown as typeof fetch;
    for (const opts of [{ url: 'https://auth.test' }, { secret: 'x' }, {}]) {
      const gs = createGatehouseStatus({ ...opts, fetch: f });
      assert.equal(gs.enabled, false);
      assert.equal(await gs.check('a@datasee.co.kr', new Date()), 'ok');
    }
    assert.equal(called, 0);
  });

  it('활성 계정은 통과, 이메일별로 60초 캐시한다', async () => {
    const h = harness(() => json(200, { email: 'a@datasee.co.kr', active: true, revoked_before: null }));
    const gs = await h.make();
    assert.equal(await gs.check('A@Datasee.co.kr', 0), 'ok');
    assert.equal(await gs.check('a@datasee.co.kr', 0), 'ok');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'https://auth.test/internal/account?email=a%40datasee.co.kr');
    assert.equal(h.calls[0].secret, 's3cret');
    h.advance(59_000);
    await gs.check('a@datasee.co.kr', 0);
    assert.equal(h.calls.length, 1);
    h.advance(2_000);
    await gs.check('a@datasee.co.kr', 0);
    assert.equal(h.calls.length, 2);
    await gs.check('b@datasee.co.kr', 0);
    assert.equal(h.calls.length, 3);
  });

  it('active:false 와 404 는 비활성', async () => {
    const h = harness((url) =>
      url.includes('gone') ? json(404, { active: false }) : json(200, { active: false, revoked_before: null })
    );
    const gs = await h.make();
    assert.equal(await gs.check('off@datasee.co.kr', Date.now()), 'inactive');
    assert.equal(await gs.check('gone@datasee.co.kr', Date.now()), 'inactive');
  });

  it('revoked_before 이전에 발급된 세션만 거절한다', async () => {
    const cut = Date.parse('2026-11-13T03:00:00.000Z');
    const h = harness(() => json(200, { active: true, revoked_before: '2026-11-13T03:00:00.000Z' }));
    const gs = await h.make();
    assert.equal(await gs.check('a@datasee.co.kr', new Date(cut - 1)), 'revoked');
    assert.equal(await gs.check('a@datasee.co.kr', new Date(cut)), 'ok');
    assert.equal(await gs.check('a@datasee.co.kr', cut + 1000), 'ok');
  });

  it('gatehouse 에 닿지 않으면 마지막 성공 결과를 쓰고, 한 번도 성공한 적 없으면 통과', async () => {
    let mode: 'down' | 'inactive' | '500' | '401' = 'down';
    const h = harness(() => {
      if (mode === 'down') throw new Error('connect ECONNREFUSED');
      if (mode === '500') return json(500, {});
      if (mode === '401') return json(401, {});
      return json(200, { active: false, revoked_before: null });
    });
    const gs = await h.make();
    // 한 번도 성공한 적 없음 → 통과
    assert.equal(await gs.check('a@datasee.co.kr', 0), 'ok');
    assert.equal(h.warnings.length, 1);
    // 실패 직후에는 다시 묻지 않는다(요청마다 타임아웃을 기다리지 않게)
    await gs.check('a@datasee.co.kr', 0);
    assert.equal(h.calls.length, 1);

    h.advance(11_000);
    mode = 'inactive';
    assert.equal(await gs.check('a@datasee.co.kr', 0), 'inactive');

    // 이후 장애·5xx·401 이어도 마지막 성공 결과(비활성)를 유지한다
    for (const m of ['down', '500', '401'] as const) {
      h.advance(61_000);
      mode = m;
      assert.equal(await gs.check('a@datasee.co.kr', 0), 'inactive', m);
    }
    assert.equal(h.calls.length, 5);
  });

  it('경고 로그는 분당 한 줄', async () => {
    const h = harness(() => {
      throw new Error('down');
    });
    const gs = await h.make();
    for (let i = 0; i < 5; i++) {
      await gs.check(`u${i}@datasee.co.kr`, 0);
    }
    assert.equal(h.calls.length, 5);
    assert.equal(h.warnings.length, 1);
    h.advance(61_000);
    await gs.check('u0@datasee.co.kr', 0);
    assert.equal(h.warnings.length, 2);
  });

  it('동시에 들어온 같은 이메일은 조회 한 번을 같이 기다린다', async () => {
    const h = harness(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return json(200, { active: true, revoked_before: null });
    });
    const gs = await h.make();
    await Promise.all(Array.from({ length: 10 }, () => gs.check('a@datasee.co.kr', 0)));
    assert.equal(h.calls.length, 1);
  });
});

describe('OIDC 클레임', () => {
  it('email_verified 가 true 가 아니면 거절한다', async () => {
    const { identityFromClaims } = await import('../src/auth/oidc.js');
    assert.deepEqual(identityFromClaims({ email: 'A@Datasee.co.kr', email_verified: true, name: '가' }), {
      email: 'a@datasee.co.kr',
      name: '가',
    });
    for (const claims of [
      { email: 'a@datasee.co.kr' },
      { email: 'a@datasee.co.kr', email_verified: false },
      { email: 'a@datasee.co.kr', email_verified: 'true' },
      { email_verified: true },
    ]) {
      assert.throws(() => identityFromClaims(claims as any), JSON.stringify(claims));
    }
  });
});

describe('HTTP 경계', () => {
  let app: FastifyInstance;
  let listId: string; // 더블 옵트인
  let singleListId: string; // 단일 옵트인
  let userId: string;
  let memberId: string;
  let readKey: { id: string; key: string };
  let writeKey: { id: string; key: string };
  const slug = `${run}-double`;
  const singleSlug = `${run}-single`;
  const userEmail = `${run}-admin@datasee.co.kr`;

  // gatehouse 가짜 응답 — 테스트마다 바꿔 끼운다.
  let gatehouseReply: () => Response = () => new Response('{"active":true,"revoked_before":null}', { status: 200 });
  let gatehouseCalls = 0;
  const useGatehouse = async () => {
    const { configureGatehouseStatus } = await import('../src/auth/gatehouseStatus.js');
    gatehouseCalls = 0;
    configureGatehouseStatus({
      url: 'https://auth.test',
      secret: 'x',
      warn: () => {},
      fetch: (async () => (gatehouseCalls++, gatehouseReply())) as unknown as typeof fetch,
    });
  };
  const noGatehouse = async () => {
    const { configureGatehouseStatus } = await import('../src/auth/gatehouseStatus.js');
    configureGatehouseStatus({});
  };

  // 웹 SSO 가짜 IdP
  let stateSeq = 0;
  const callbackCalls: string[] = [];
  const fakeOidc = {
    enabled: () => true,
    buildAuthUrl: async () => {
      const state = `st${++stateSeq}-${run}`;
      return { url: `https://idp.test/authorize?state=${state}`, state, codeVerifier: `v-${state}` };
    },
    handleCallback: async (_url: URL, state: string, verifier: string) => {
      callbackCalls.push(`${state}|${verifier}`);
      return { email: userEmail, name: '관리자' };
    },
  };

  before(async () => {
    app = await makeApp({ auth: { oidc: fakeOidc } });
    const { one, query } = await db();
    const mk = async (s: string, doubleOptin: boolean) => {
      const l = await one<{ id: string }>(
        `insert into lists (name, slug, double_optin, default_sender_email, form_enabled)
         values ($1, $2, $3, 'news@datasee.co.kr', true) returning id`,
        [s, s, doubleOptin]
      );
      await query(
        `insert into custom_fields (list_id, key, label, is_system, position)
         values ($1,'email','이메일',true,0), ($1,'name','이름',true,1), ($1,'company','회사',false,2)`,
        [l!.id]
      );
      return l!.id;
    };
    listId = await mk(slug, true);
    singleListId = await mk(singleSlug, false);

    const u = await one<{ id: string }>(
      `insert into users (email, name, role) values ($1, '관리자', 'owner') returning id`,
      [userEmail]
    );
    userId = u!.id;
    const m = await one<{ id: string }>(
      `insert into users (email, name, role) values ($1, '멤버', 'member') returning id`,
      [`${run}-member@datasee.co.kr`]
    );
    memberId = m!.id;

    const { createApiKey } = await import('../src/auth/service.js');
    readKey = (await createApiKey(`${run}-read`, null, ['read'])) as any;
    writeKey = (await createApiKey(`${run}-write`, null, ['read', 'write'])) as any;
  });

  after(async () => {
    await noGatehouse();
    const { query } = await db();
    await query('delete from audit_log where list_id = any($1) or api_key_id = any($2) or actor_user_id = any($3)', [
      [listId, singleListId],
      [readKey.id, writeKey.id],
      [userId, memberId],
    ]);
    await query(`delete from campaigns where name like $1`, [`${run}%`]);
    await query('delete from lists where id = any($1)', [[listId, singleListId]]);
    await query('delete from api_keys where id = any($1)', [[readKey.id, writeKey.id]]);
    await query('delete from users where id = any($1)', [[userId, memberId]]);
    await app.close();
    await closeDb();
  });

  const sub = async (list: string, email: string) => {
    const { one } = await db();
    return one<{ id: string; status: string; fields: Record<string, unknown>; ad_agreed: boolean }>(
      'select id, status, fields, ad_agreed from subscribers where list_id = $1 and lower(email) = $2',
      [list, email]
    );
  };
  const seed = async (list: string, email: string, status: string, fields: object, adAgreed: boolean) => {
    const { query } = await db();
    await query(
      `insert into subscribers (list_id, email, status, fields, ad_agreed) values ($1,$2,$3,$4::jsonb,$5)`,
      [list, email, status, JSON.stringify(fields), adAgreed]
    );
  };
  const lastToken = async (subscriberId: string) => {
    const { one } = await db();
    return one<{ token: string; payload: any }>(
      `select token, payload from subscriber_tokens where subscriber_id = $1 and kind = 'confirm'
        order by created_at desc limit 1`,
      [subscriberId]
    );
  };
  const postJson = (s: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/public/lists/${s}/subscribe`,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      payload: JSON.stringify(body),
    });
  const postForm = (url: string, body: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() },
      payload: new URLSearchParams(body).toString(),
    });

  describe('구독 신청이 기존 구독자를 덮어쓰지 않는다', () => {
    it('더블 옵트인: 구독 중인 주소로 신청해도 필드·동의가 그대로다. 확인하면 그때 반영된다', async () => {
      const email = `${run}-a@example.com`;
      await seed(listId, email, 'subscribed', { name: '원래이름', company: '원래회사' }, true);

      const res = await postJson(slug, {
        email,
        fields: { name: '공격자', evil: '<script>', company: '' },
        ad_agreed: false,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().ok, true);
      assert.equal(res.json().confirmSent, true);

      const before = await sub(listId, email);
      assert.deepEqual(before!.fields, { name: '원래이름', company: '원래회사' });
      assert.equal(before!.ad_agreed, true);
      assert.equal(before!.status, 'subscribed');

      // 바꿀 내용은 토큰에만 있다 — 정의되지 않은 키(evil)와 빈 값은 빠진다.
      const tok = await lastToken(before!.id);
      assert.deepEqual(tok!.payload, { fields: { name: '공격자' }, adAgreed: false });

      const confirm = await app.inject({ method: 'GET', url: `/c/${tok!.token}` });
      assert.equal(confirm.statusCode, 200);
      const afterConfirm = await sub(listId, email);
      assert.deepEqual(afterConfirm!.fields, { name: '공격자', company: '원래회사' });
      assert.equal(afterConfirm!.ad_agreed, false);

      // 토큰은 한 번만 통한다.
      const again = await app.inject({ method: 'GET', url: `/c/${tok!.token}` });
      assert.ok(again.body.includes('이미 확인이 완료된'));
    });

    it('더블 옵트인: 수신거부한 주소는 확인 전까지 수신거부 그대로다', async () => {
      const email = `${run}-b@example.com`;
      await seed(listId, email, 'unsubscribed', { name: '거부한사람' }, false);

      const res = await postForm(`/s/${slug}`, { email, name: '다시', ad_agreed: 'on' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('구독 확인 이메일을 보냈습니다'));

      const s1 = await sub(listId, email);
      assert.equal(s1!.status, 'unsubscribed');
      assert.deepEqual(s1!.fields, { name: '거부한사람' });
      assert.equal(s1!.ad_agreed, false);

      const tok = await lastToken(s1!.id);
      await app.inject({ method: 'GET', url: `/c/${tok!.token}` });
      const s2 = await sub(listId, email);
      assert.equal(s2!.status, 'subscribed');
      assert.deepEqual(s2!.fields, { name: '다시' });
      assert.equal(s2!.ad_agreed, true);
    });

    it('단일 옵트인: 수신거부·삭제된 주소는 바로 되살리지 않고 확인 메일을 거친다', async () => {
      for (const status of ['unsubscribed', 'deleted']) {
        const email = `${run}-c-${status}@example.com`;
        await seed(singleListId, email, status, { name: '원래' }, false);

        const res = await postJson(singleSlug, { email, fields: { name: '남이넣음' }, ad_agreed: true });
        assert.equal(res.json().confirmSent, true, status);
        const s1 = await sub(singleListId, email);
        assert.equal(s1!.status, status);
        assert.deepEqual(s1!.fields, { name: '원래' });
        assert.equal(s1!.ad_agreed, false);

        const tok = await lastToken(s1!.id);
        assert.ok(tok, '확인 토큰이 발급돼야 한다');
        await app.inject({ method: 'GET', url: `/c/${tok!.token}` });
        assert.equal((await sub(singleListId, email))!.status, 'subscribed');
      }
    });

    it('단일 옵트인: 구독 중인 주소는 아무것도 바뀌지 않고 메일도 나가지 않는다', async () => {
      const email = `${run}-d@example.com`;
      await seed(singleListId, email, 'subscribed', { name: '원래' }, true);
      const res = await postForm(`/s/${singleSlug}`, { email, name: '덮어쓰기' });
      assert.equal(res.statusCode, 200);
      const s = await sub(singleListId, email);
      assert.deepEqual(s!.fields, { name: '원래' });
      assert.equal(s!.ad_agreed, true);
      assert.equal(await lastToken(s!.id), null);
    });

    it('새 주소: 주소록에 정의된 키만 저장한다', async () => {
      const email = `${run}-e@example.com`;
      const res = await postJson(singleSlug, {
        email: `  ${email.toUpperCase()} `,
        fields: { name: '새사람', company: '회사', role: 'admin', __proto__x: 1, nested: { a: 1 }, email: 'x@y.zz' },
        adAgreed: true,
      });
      assert.equal(res.json().result, 'created');
      assert.equal(res.json().confirmSent, false);
      const s = await sub(singleListId, email);
      assert.equal(s!.status, 'subscribed');
      assert.deepEqual(s!.fields, { name: '새사람', company: '회사' });
      assert.equal(s!.ad_agreed, true);

      // 더블 옵트인 주소록의 새 주소는 pending 으로 들어가고 확인 메일이 나간다.
      const email2 = `${run}-f@example.com`;
      const res2 = await postForm(`/s/${slug}`, { email: email2, name: '대기', junk: 'x' });
      assert.ok(res2.body.includes('구독 확인 이메일을 보냈습니다'));
      const s2 = await sub(listId, email2);
      assert.equal(s2!.status, 'pending');
      assert.deepEqual(s2!.fields, { name: '대기' });
    });

    it('구독 정보 변경(/p/:token): 본인 토큰으로 허용된 필드만 바꾼다', async () => {
      const email = `${run}-g@example.com`;
      await seed(listId, email, 'subscribed', { name: '원래', company: '회사' }, false);
      const s = await sub(listId, email);
      const { signPayload } = await import('../src/lib/crypto.js');

      const res = await postForm(`/p/${signPayload(`p${s!.id}`)}`, {
        name: '바꿈',
        company: '',
        role: 'owner',
        status: 'deleted',
        ad_agreed: 'on',
      });
      assert.equal(res.statusCode, 200);
      const s2 = await sub(listId, email);
      assert.deepEqual(s2!.fields, { name: '바꿈', company: '' });
      assert.equal(s2!.ad_agreed, true);
      assert.equal(s2!.status, 'subscribed');

      // 서명이 틀린 토큰은 통하지 않는다.
      const bad = await postForm(`/p/p${s!.id}.aaaaaaaaaaaaaaaaaaaaaa`, { name: '위조' });
      assert.equal(bad.statusCode, 404);
      assert.equal((await sub(listId, email))!.fields.name, '바꿈');
    });
  });

  describe('웹에서 보기·보안 헤더·CORS', () => {
    let campaignId: string;
    let linkId: string;
    let otherLinkId: string;
    let recipientId: string;
    const wslug = `${run}-web`;

    before(async () => {
      const { one } = await db();
      const c = await one<{ id: string }>(
        `insert into campaigns (name, list_id, subject, status, public_slug, public_visibility, content_html)
         values ($1, $2, '제목', 'sent', $3, 'public', '') returning id`,
        [`${run}-c1`, listId, wslug]
      );
      campaignId = c!.id;
      const l = await one<{ id: string }>(
        `insert into campaign_links (campaign_id, url) values ($1, 'https://example.com/a?x=1&y=2') returning id`,
        [campaignId]
      );
      linkId = l!.id;
      const html =
        `<html><body><script>alert(document.cookie)</script><p>$%name%$</p>` +
        `<a href="${PUBLIC}/t/c/__MR_RCPT__/${linkId}">링크</a>` +
        `<img src="${PUBLIC}/t/o/__MR_RCPT__.gif" /></body></html>`;
      const { query } = await db();
      await query('update campaigns set content_html = $2 where id = $1', [campaignId, html]);
      const r = await one<{ id: string }>(
        `insert into campaign_recipients (campaign_id, email, status) values ($1, 'r@example.com', 'sent') returning id`,
        [campaignId]
      );
      recipientId = r!.id;

      const c2 = await one<{ id: string }>(
        `insert into campaigns (name, list_id, subject, status) values ($1, $2, '다른 캠페인', 'sent') returning id`,
        [`${run}-c2`, listId]
      );
      const l2 = await one<{ id: string }>(
        `insert into campaign_links (campaign_id, url) values ($1, 'https://secret.example.com/unreleased') returning id`,
        [c2!.id]
      );
      otherLinkId = l2!.id;
    });

    it('/w/:slug 는 스크립트를 끄고 sandbox 로 오리진을 떼어 낸다', async () => {
      const res = await app.inject({ method: 'GET', url: `/w/${wslug}` });
      assert.equal(res.statusCode, 200);
      const csp = String(res.headers['content-security-policy']);
      for (const d of ["script-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
        assert.ok(csp.includes(d), d);
      }
      const sandbox = /sandbox ([^;]*)/.exec(csp)?.[1] ?? '';
      assert.ok(sandbox.includes('allow-popups') && sandbox.includes('allow-forms'));
      assert.ok(!sandbox.includes('allow-scripts'));
      assert.ok(!sandbox.includes('allow-same-origin'));
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'DENY');

      // 인코딩한 경로로도 같은 헤더가 붙는다.
      const enc = await app.inject({ method: 'GET', url: `/%77/${wslug}` });
      assert.ok(String(enc.headers['content-security-policy']).includes('sandbox'));
    });

    it('웹뷰의 추적 링크는 원래 주소로 되돌려져 있다(토큰 없이도 열린다)', async () => {
      const res = await app.inject({ method: 'GET', url: `/w/${wslug}` });
      assert.ok(res.body.includes('href="https://example.com/a?x=1&amp;y=2"'));
      assert.ok(!res.body.includes('/t/c/'));
      assert.ok(!res.body.includes('$%name%$'));
    });

    it('구독폼·수신거부 같은 공개 HTML 에도 CSP 가 붙는다(sandbox 는 없음)', async () => {
      const res = await app.inject({ method: 'GET', url: `/s/${slug}` });
      const csp = String(res.headers['content-security-policy']);
      assert.ok(csp.includes("script-src 'none'") && csp.includes("form-action 'self'"));
      assert.ok(!csp.includes('sandbox'));
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    it('API 응답에도 nosniff 가 붙는다', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    it('CORS: 관리 오리진만 자격증명 허용 — 공개 오리진은 빠졌다', async () => {
      const from = (origin: string) =>
        app.inject({ method: 'GET', url: '/api/auth/status', headers: { origin } });
      const admin = await from(ADMIN);
      assert.equal(admin.headers['access-control-allow-origin'], ADMIN);
      assert.equal(admin.headers['access-control-allow-credentials'], 'true');
      for (const origin of [PUBLIC, 'https://evil.example']) {
        const res = await from(origin);
        assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
      }
    });

    describe('클릭 추적', () => {
      it('토큰이 틀리면 리다이렉트하지 않는다(404) — linkId 로 주소를 긁을 수 없다', async () => {
        for (const token of ['x', 'web', 'map', `r${recipientId}.aaaaaaaaaaaaaaaaaaaaaa`, `r${recipientId}`]) {
          const res = await app.inject({ method: 'GET', url: `/t/c/${token}/${linkId}` });
          assert.equal(res.statusCode, 404, token);
          assert.equal(res.headers.location, undefined);
          assert.ok(!res.body.includes('example.com'));
        }
      });

      it('맞는 토큰이면 이동하고 클릭을 기록한다', async () => {
        const { recipientToken } = await import('../src/render/tracking.js');
        const res = await app.inject({ method: 'GET', url: `/t/c/${recipientToken(recipientId)}/${linkId}` });
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, 'https://example.com/a?x=1&y=2');
        const { one } = await db();
        const l = await one<{ click_count: number }>('select click_count from campaign_links where id = $1', [linkId]);
        assert.equal(l!.click_count, 1);
      });

      it('맞는 토큰이라도 다른 캠페인의 링크는 열어 주지 않는다', async () => {
        const { recipientToken } = await import('../src/render/tracking.js');
        const token = recipientToken(recipientId);
        for (const id of [otherLinkId, '999999999', 'abc', '1e3']) {
          const res = await app.inject({ method: 'GET', url: `/t/c/${token}/${id}` });
          assert.equal(res.statusCode, 404, id);
          assert.equal(res.headers.location, undefined);
        }
      });
    });
  });

  describe('세션', () => {
    const cookieFor = (token: string) => ({ cookie: `mailroom_session=${token}` });
    const me = async (headers: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers })).json().user;
    const sessionRow = async (token: string) => {
      const { one } = await db();
      const { sha256 } = await import('../src/lib/crypto.js');
      return one<{ created_at: Date; expires_at: Date; kind: string }>(
        'select created_at, expires_at, kind from sessions where token_hash = $1',
        [sha256(token)]
      );
    };
    const countSessions = async () => {
      const { one } = await db();
      return (await one<{ n: number }>('select count(*)::int as n from sessions where user_id = $1', [userId]))!.n;
    };
    const HOUR = 3_600_000;

    it('웹 세션은 유휴 24시간, CLI 세션은 7일로 발급된다', async () => {
      await noGatehouse();
      const { createSession } = await import('../src/auth/service.js');
      const web = await createSession(userId, 'web');
      const cli = await createSession(userId, 'cli');
      const near = (d: Date, ms: number) => Math.abs(d.getTime() - Date.now() - ms) < 60_000;
      assert.ok(near(web.expiresAt, 24 * HOUR));
      assert.ok(near(web.absoluteExpiresAt, 7 * 24 * HOUR));
      assert.ok(near(cli.expiresAt, 7 * 24 * HOUR));
      assert.equal((await sessionRow(cli.token))!.kind, 'cli');
      assert.equal((await me(cookieFor(web.token))).email, userEmail);
      assert.equal((await me({ authorization: `Bearer ${cli.token}` })).email, userEmail);
    });

    it('쓰는 동안 유휴 만료가 밀리지만 발급 후 7일은 넘지 못한다', async () => {
      await noGatehouse();
      const { createSession } = await import('../src/auth/service.js');
      const { query } = await db();
      const { sha256 } = await import('../src/lib/crypto.js');

      // 만료가 2시간 남은 세션 → 사용하면 24시간 뒤로 밀린다.
      const a = await createSession(userId, 'web');
      await query(`update sessions set expires_at = now() + interval '2 hours' where token_hash = $1`, [sha256(a.token)]);
      assert.ok(await me(cookieFor(a.token)));
      await new Promise((r) => setTimeout(r, 100)); // 연장은 응답을 기다리지 않고 나간다
      const ra = await sessionRow(a.token);
      assert.ok(ra!.expires_at.getTime() - Date.now() > 23 * HOUR);

      // 발급된 지 6일 23시간 지난 세션 → 1시간 뒤(발급 후 7일)에서 멈춘다.
      const b = await createSession(userId, 'web');
      await query(
        `update sessions set created_at = now() - interval '6 days 23 hours', expires_at = now() + interval '30 minutes'
          where token_hash = $1`,
        [sha256(b.token)]
      );
      assert.ok(await me(cookieFor(b.token)));
      await new Promise((r) => setTimeout(r, 100));
      const rb = await sessionRow(b.token);
      const left = rb!.expires_at.getTime() - Date.now();
      assert.ok(left > 50 * 60_000 && left <= HOUR + 1000, `남은 시간 ${left}`);

      // 만료된 세션은 통하지 않는다.
      await query(`update sessions set expires_at = now() - interval '1 second' where token_hash = $1`, [sha256(b.token)]);
      assert.equal(await me(cookieFor(b.token)), null);
    });

    it('gatehouse 가 비활성이라고 하면 거절하고 그 사용자의 세션을 전부 지운다', async () => {
      const { createSession } = await import('../src/auth/service.js');
      const web = await createSession(userId, 'web');
      const cli = await createSession(userId, 'cli');
      assert.ok((await countSessions()) >= 2);

      gatehouseReply = () => new Response('{"active":false,"revoked_before":null}', { status: 200 });
      await useGatehouse();
      assert.equal(await me(cookieFor(web.token)), null);
      assert.equal(await countSessions(), 0);
      const guarded = await app.inject({
        method: 'GET',
        url: '/api/lists',
        headers: { authorization: `Bearer ${cli.token}` },
      });
      assert.equal(guarded.statusCode, 401);
    });

    it('gatehouse 가 모르는 이메일(404)도 비활성으로 취급한다', async () => {
      const { createSession } = await import('../src/auth/service.js');
      const cli = await createSession(userId, 'cli');
      gatehouseReply = () => new Response('{"active":false}', { status: 404 });
      await useGatehouse();
      assert.equal(await me({ authorization: `Bearer ${cli.token}` }), null);
      assert.equal(await countSessions(), 0);
    });

    it('revoked_before 이전에 발급된 세션만 끊고, 그 뒤 세션은 살려 둔다', async () => {
      const { createSession } = await import('../src/auth/service.js');
      const { query } = await db();
      const { sha256 } = await import('../src/lib/crypto.js');
      const old = await createSession(userId, 'web');
      await query(`update sessions set created_at = now() - interval '2 hours' where token_hash = $1`, [sha256(old.token)]);
      const fresh = await createSession(userId, 'web');

      const cut = new Date(Date.now() - 3_600_000).toISOString();
      gatehouseReply = () => new Response(JSON.stringify({ active: true, revoked_before: cut }), { status: 200 });
      await useGatehouse();
      assert.equal(await me(cookieFor(old.token)), null);
      assert.equal((await me(cookieFor(fresh.token))).email, userEmail);
      assert.equal(await sessionRow(old.token), null);
      assert.ok(await sessionRow(fresh.token));
      assert.equal(gatehouseCalls, 1, '이메일별 캐시');
    });

    it('gatehouse 장애 때는 통과시키고, API 키는 조회 대상이 아니다', async () => {
      const { createSession } = await import('../src/auth/service.js');
      const web = await createSession(userId, 'web');
      gatehouseReply = () => {
        throw new Error('ECONNREFUSED');
      };
      await useGatehouse();
      assert.equal((await me(cookieFor(web.token))).email, userEmail);

      gatehouseReply = () => new Response('{"active":false}', { status: 404 });
      await useGatehouse();
      const res = await app.inject({
        method: 'GET',
        url: '/api/lists',
        headers: { authorization: `Bearer ${writeKey.key}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(gatehouseCalls, 0);
      await noGatehouse();
    });
  });

  describe('OIDC state 바인딩', () => {
    const start = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
      assert.equal(res.statusCode, 302);
      const state = new URL(String(res.headers.location)).searchParams.get('state')!;
      const c = res.cookies.find((x) => x.name === 'mailroom_oidc')!;
      return { state, cookie: c };
    };
    const callback = (state: string, cookie?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`,
        headers: cookie ? { cookie: `mailroom_oidc=${cookie}` } : {},
      });

    it('시작할 때 서명된 단기 쿠키를 심는다', async () => {
      await noGatehouse();
      const { cookie, state } = await start();
      assert.equal(cookie.httpOnly, true);
      assert.equal(String(cookie.sameSite).toLowerCase(), 'lax');
      assert.equal(cookie.path, '/api/auth/oidc');
      assert.equal(cookie.maxAge, 600);
      assert.ok(cookie.value.startsWith(`${state}.`));
    });

    it('쿠키 없이 콜백만 열면 로그인되지 않는다(로그인 CSRF)', async () => {
      const { state } = await start();
      const before = callbackCalls.length;
      const res = await callback(state);
      assert.equal(res.statusCode, 400);
      assert.equal(callbackCalls.length, before, 'IdP 코드 교환까지 가면 안 된다');
      assert.ok(!res.cookies.some((c) => c.name === 'mailroom_session' && c.value));
    });

    it('다른 로그인 시도의 쿠키·위조한 쿠키로는 통하지 않는다', async () => {
      const victim = await start();
      const attacker = await start();
      const before = callbackCalls.length;
      // 공격자의 state 를 피해자 브라우저(피해자 쿠키)에서 연다.
      assert.equal((await callback(attacker.state, victim.cookie.value)).statusCode, 400);
      // 서명 없는 쿠키, 서명을 바꾼 쿠키
      assert.equal((await callback(attacker.state, `${attacker.state}.${Date.now() + 60_000}`)).statusCode, 400);
      assert.equal((await callback(attacker.state, attacker.cookie.value.slice(0, -2) + 'zz')).statusCode, 400);
      assert.equal(callbackCalls.length, before);
    });

    it('만료된 쿠키는 통하지 않는다', async () => {
      const { state } = await start();
      const { signPayload } = await import('../src/lib/crypto.js');
      const expired = signPayload(`${state}.${Date.now() - 1000}`);
      assert.equal((await callback(state, expired)).statusCode, 400);
    });

    it('같은 브라우저에서 시작한 로그인은 통하고, 한 번만 쓸 수 있다', async () => {
      const { state, cookie } = await start();
      const res = await callback(state, cookie.value);
      assert.equal(res.statusCode, 302);
      assert.equal(callbackCalls.at(-1), `${state}|v-${state}`);
      const session = res.cookies.find((c) => c.name === 'mailroom_session')!;
      assert.ok(session.value);
      assert.equal(session.httpOnly, true);
      // 쿠키는 최장 수명(7일)까지
      const days = (new Date(session.expires!).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 6.9 && days < 7.1, `쿠키 수명 ${days}일`);
      // state 쿠키는 지운다
      assert.ok(res.cookies.some((c) => c.name === 'mailroom_oidc' && !c.value));
      // 재사용 불가
      assert.equal((await callback(state, cookie.value)).statusCode, 400);
    });
  });

  describe('권한', () => {
    const asKey = (key: string) => ({ authorization: `Bearer ${key}` });
    let adminHeaders: Record<string, string>;

    before(async () => {
      await noGatehouse();
      const { createSession } = await import('../src/auth/service.js');
      adminHeaders = { cookie: `mailroom_session=${(await createSession(userId, 'web')).token}` };
    });

    it('역할은 owner/admin/member 만 받는다', async () => {
      const patch = (body: unknown) =>
        app.inject({
          method: 'PATCH',
          url: `/api/users/${memberId}`,
          headers: { ...adminHeaders, 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
      for (const role of ['superuser', 'Admin', 'admin ', '', 1, true, ['admin'], { a: 1 }]) {
        assert.equal((await patch({ role })).statusCode, 400, JSON.stringify(role));
      }
      assert.equal((await patch({ is_active: 'false' })).statusCode, 400);
      const { one } = await db();
      const row = () => one<{ role: string; is_active: boolean }>('select role, is_active from users where id = $1', [memberId]);
      assert.deepEqual(await row(), { role: 'member', is_active: true });

      assert.equal((await patch({ role: 'admin' })).statusCode, 200);
      assert.equal((await row())!.role, 'admin');
      assert.equal((await patch({ role: 'member' })).statusCode, 200);
    });

    it('API 키 권한 값도 정해진 것만 받는다', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/keys',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: `${run}-bad`, scopes: ['read', 'root'] }),
      });
      assert.equal(res.statusCode, 400);
    });

    it('읽기 전용 키는 읽을 수 있지만 쓰기 라우트는 전부 403', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/lists', headers: asKey(readKey.key) })).statusCode, 200);
      const writes: Array<[string, string]> = [
        ['POST', '/api/lists'],
        ['POST', `/api/lists/${listId}/subscribers`],
        ['DELETE', `/api/lists/${listId}`],
        ['POST', '/api/campaigns'],
        ['PATCH', `/api/users/${memberId}`],
        ['PUT', '/api/settings/utm'],
        ['POST', `/v1/lists/${listId}/subscribers`],
      ];
      for (const [method, url] of writes) {
        const res = await app.inject({
          method: method as any,
          url,
          headers: { ...asKey(readKey.key), 'content-type': 'application/json' },
          payload: '{}',
        });
        assert.equal(res.statusCode, 403, `${method} ${url}`);
      }
      // 바꾸는 게 없는 POST(미리보기 렌더)는 읽기 키로도 된다.
      const preview = await app.inject({
        method: 'POST',
        url: '/api/render/preview',
        headers: { ...asKey(readKey.key), 'content-type': 'application/json' },
        payload: JSON.stringify({ content: [] }),
      });
      assert.equal(preview.statusCode, 200);
      // 주소록이 지워지지 않았다.
      const { one } = await db();
      assert.ok(await one('select 1 from lists where id = $1', [listId]));
    });
  });

  describe('내보내기 감사 기록', () => {
    let auditListId: string;
    let adminHeaders: Record<string, string>;
    const asKey = (key: string) => ({ authorization: `Bearer ${key}` });

    before(async () => {
      await noGatehouse();
      const { one, query } = await db();
      const l = await one<{ id: string }>('insert into lists (name, slug) values ($1, $1) returning id', [`${run}-audit`]);
      auditListId = l!.id;
      await query(
        `insert into subscribers (list_id, email)
         select $1, 'u' || g || '@example.com' from generate_series(1, 130) g`,
        [auditListId]
      );
      const { createSession } = await import('../src/auth/service.js');
      adminHeaders = { cookie: `mailroom_session=${(await createSession(userId, 'web')).token}` };
    });

    after(async () => {
      const { query } = await db();
      await query('delete from audit_log where list_id = $1', [auditListId]);
      await query('delete from lists where id = $1', [auditListId]);
    });

    const entries = async () => {
      const { many } = await db();
      return many<any>('select * from audit_log where list_id = $1 order by id', [auditListId]);
    };

    it('CSV 내보내기를 누가 했는지 남긴다(API 키)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/lists/${auditListId}/subscribers/export`,
        headers: { ...asKey(readKey.key), 'x-forwarded-for': '203.0.113.9' },
      });
      assert.equal(res.statusCode, 200);
      const rows = await entries();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'subscribers.export');
      assert.equal(rows[0].row_count, 130);
      assert.equal(rows[0].api_key_id, readKey.id);
      assert.equal(rows[0].api_key_name, `${run}-read`);
      assert.equal(rows[0].actor_user_id, null);
      assert.equal(rows[0].ip, '203.0.113.9');
      assert.ok(rows[0].created_at instanceof Date);
    });

    it('한 페이지(100건)를 넘는 조회만 대량 조회로 남긴다(사용자)', async () => {
      const list = (limit: number) =>
        app.inject({ method: 'GET', url: `/api/lists/${auditListId}/subscribers?limit=${limit}`, headers: adminHeaders });
      assert.equal((await list(100)).json().subscribers.length, 100);
      assert.equal((await entries()).length, 1);

      assert.equal((await list(1000)).json().subscribers.length, 130);
      const rows = await entries();
      assert.equal(rows.length, 2);
      assert.equal(rows[1].action, 'subscribers.bulk_read');
      assert.equal(rows[1].row_count, 130);
      assert.equal(rows[1].actor_user_id, userId);
      assert.equal(rows[1].actor_email, userEmail);
      assert.equal(rows[1].api_key_id, null);
    });

    it('관리자만 감사 기록을 읽는다', async () => {
      const url = `/api/audit?listId=${auditListId}`;
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
      assert.equal((await app.inject({ method: 'GET', url, headers: asKey(writeKey.key) })).statusCode, 403);

      const res = await app.inject({ method: 'GET', url, headers: adminHeaders });
      assert.equal(res.statusCode, 200);
      const got = res.json().entries;
      assert.deepEqual(got.map((e: any) => e.action), ['subscribers.bulk_read', 'subscribers.export']);
      assert.equal(got[0].list_name, `${run}-audit`);

      const filtered = await app.inject({ method: 'GET', url: `${url}&action=subscribers.export`, headers: adminHeaders });
      assert.equal(filtered.json().entries.length, 1);
    });
  });
});
