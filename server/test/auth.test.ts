import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { closeDb, db, makeApp } from './helpers.js';

/**
 * 인증 훅 회귀 테스트.
 *
 * 사고: 훅이 원본 URL 접두어로 "인증이 필요한가"를 판단해서, 라우터가 디코딩해 주는
 * `/%61pi/lists` 가 인증 없이 `/api/lists` 핸들러에 닿았다.
 */

type Route = { method: string; url: string };

/** 인증 없이 열려 있어야 하는 라우트 전부. 늘리거나 줄이면 이 테스트가 깨져서 눈에 띈다. */
const EXPECTED_PUBLIC = [
  'GET /a/:id',
  'GET /api/auth/oidc/callback',
  'GET /api/auth/oidc/start',
  'GET /api/auth/status',
  'GET /api/health',
  'GET /c/:token',
  'GET /healthz',
  'GET /p/:token',
  'GET /s/:slug',
  'GET /t/c/:token/:linkId',
  'GET /t/o/:token',
  'GET /u/:token',
  'GET /w/:slug',
  'POST /api/auth/cli/exchange',
  'POST /api/public/lists/:slug/subscribe',
  'POST /api/webhooks/ses',
  'POST /p/:token',
  'POST /s/:slug',
  'POST /u/:token',
];
/** 훅은 타지만 신원이 없어도 통과시키는 곳. */
const ANONYMOUS_OK = ['GET /api/auth/me', 'POST /api/auth/logout'];
/** API 핸들러가 아닌 와일드카드(정적 파일, CORS OPTIONS). */
const WILDCARDS = new Set(['/*', '*']);

const fill = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, '1');

describe('인증 훅', () => {
  let app: FastifyInstance;
  let webDist: string;
  let apiKey: string;
  let apiKeyId: string;
  const routes: Route[] = [];

  before(async () => {
    webDist = mkdtempSync(join(tmpdir(), 'mailroom-web-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>spa-shell</title>');
    app = await makeApp({
      webDist,
      onRoute: (r) => {
        for (const method of [r.method].flat()) {
          if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: r.url });
        }
      },
    });
    const { createApiKey } = await import('../src/auth/service.js');
    const key = await createApiKey('auth-test', null, ['read', 'write']);
    apiKey = key.key;
    apiKeyId = key.id;
  });

  after(async () => {
    const { query } = await db();
    await query('delete from api_keys where id = $1', [apiKeyId]);
    await app.close();
    await closeDb();
    rmSync(webDist, { recursive: true, force: true });
  });

  const privateRoutes = () =>
    routes.filter(
      (r) =>
        !WILDCARDS.has(r.url) &&
        !EXPECTED_PUBLIC.includes(`${r.method} ${r.url}`) &&
        !ANONYMOUS_OK.includes(`${r.method} ${r.url}`)
    );

  it('/api/lists 는 인증 없이 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lists' });
    assert.equal(res.statusCode, 401);
  });

  // 실제로 뚫렸던 요청과 그 변형들. 어느 것도 데이터를 돌려주면 안 된다.
  for (const [method, url] of [
    ['GET', '/%61pi/lists'],
    ['GET', '/%41PI/lists'],
    ['GET', '/api%2Flists'],
    ['GET', '/%61pi/lists;x/../../a/x'],
    ['GET', '/api/lists;x/../../a/x'],
    ['GET', '/api/lists;x'],
    ['GET', '/%61pi/lists?x=/a/'],
    ['GET', '//api/lists'],
    ['GET', '/a/../api/lists'],
    ['GET', '/%61pi/lists/1/subscribers/export'],
    ['POST', '/v%31/lists/1/subscribers'],
    ['GET', '/v%31/lists/1/subscribers'],
    ['DELETE', '/%76%31/lists/1/subscribers'],
  ] as const) {
    it(`우회 시도 ${method} ${url} → 401/404`, async () => {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      assert.ok([401, 404].includes(res.statusCode), `status ${res.statusCode}: ${res.body.slice(0, 200)}`);
      assert.ok(!res.body.includes('"lists"'), '목록 데이터가 새면 안 된다');
      assert.ok(!res.body.includes('spa-shell') || res.statusCode === 404);
    });
  }

  it('공개 라우트 목록이 기대한 것과 정확히 같다', async () => {
    const { PUBLIC_ROUTES } = await import('../src/auth/plugin.js');
    // 1) 허용 목록의 패턴은 전부 실제로 등록된 라우트여야 한다(오타·죽은 항목 방지).
    const registered = new Set(routes.map((r) => r.url));
    for (const pattern of PUBLIC_ROUTES) assert.ok(registered.has(pattern), `등록되지 않은 공개 패턴: ${pattern}`);
    // 2) 그 패턴으로 열리는 (메서드, 경로) 조합이 기대 목록과 같아야 한다.
    const open = routes
      .filter((r) => PUBLIC_ROUTES.has(r.url))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    assert.deepEqual(open, [...EXPECTED_PUBLIC].sort());
  });

  it('공개 목록에 없는 라우트는 전부 인증 없이 401 (기본 거부)', async () => {
    const targets = privateRoutes();
    assert.ok(targets.length > 80, `라우트 수집이 이상하다: ${targets.length}`);
    for (const r of targets) {
      const res = await app.inject({ method: r.method as any, url: fill(r.url) });
      assert.equal(res.statusCode, 401, `${r.method} ${r.url} → ${res.statusCode}`);
    }
  });

  it('모든 비공개 라우트는 첫 글자를 퍼센트 인코딩해도 401', async () => {
    for (const r of privateRoutes()) {
      const path = fill(r.url);
      const encoded = `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`;
      const res = await app.inject({ method: r.method as any, url: encoded });
      assert.equal(res.statusCode, 401, `${r.method} ${encoded} → ${res.statusCode}`);
    }
  });

  it('잘못된 자격증명은 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/lists',
      headers: { authorization: 'Bearer mrk_not-a-real-key' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('API 키가 있으면 그대로 동작한다', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lists', headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().lists));

    // AccessToken 헤더(외부 연동 호환)도 그대로.
    const compat = await app.inject({ method: 'GET', url: '/api/lists', headers: { accesstoken: apiKey } });
    assert.equal(compat.statusCode, 200);
  });

  it('공개 라우트는 인증 없이 동작한다', async () => {
    const pixel = await app.inject({ method: 'GET', url: '/t/o/not-a-token.gif' });
    assert.equal(pixel.statusCode, 200);
    assert.equal(pixel.headers['content-type'], 'image/gif');

    for (const url of ['/api/health', '/healthz', '/api/auth/status']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
    }

    // 없는 토큰이라도 401 이 아니라 핸들러의 응답이 나와야 한다.
    for (const url of ['/u/x', '/p/x', '/c/x', '/w/x', '/s/x', '/a/x', '/t/c/x/1']) {
      const res = await app.inject({ method: 'GET', url });
      assert.notEqual(res.statusCode, 401, url);
    }
    const sub = await app.inject({ method: 'POST', url: '/api/public/lists/no-such-list/subscribe', payload: {} });
    assert.notEqual(sub.statusCode, 401);
  });

  it('로그인 화면이 묻는 /api/auth/me 는 신원이 없어도 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { user: null });
  });

  it('매칭되는 라우트가 없으면 SPA 또는 404 — API 핸들러에 닿지 않는다', async () => {
    const spa = await app.inject({ method: 'GET', url: '/emails/123' });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.body, /spa-shell/);

    for (const url of ['/api/nope', '/v1/nope', '/API/lists', '/api%2Flists', '/api']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.json().error, 'not_found', url);
    }
  });

  it('공개 HTML 의 보안 헤더는 경로를 인코딩해도 붙는다', async () => {
    for (const url of ['/w/no-such-slug', '/%77/no-such-slug']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
    }
  });
});
