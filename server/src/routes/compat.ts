import type { FastifyInstance } from 'fastify';
import { one } from '../db/pool.js';
import { requireWrite } from '../auth/plugin.js';
import { normalizeEmail, setStatus, upsertSubscriber } from '../lib/subscribers.js';

/**
 * 구독자 연동 v1 API.
 * 기존 연동(구독폼, 백엔드에서 구독자 추가)이 base URL 과 토큰만 바꾸면 그대로 붙도록,
 * 흔한 뉴스레터 서비스의 v1 API 와 요청/응답 모양을 맞춘다. 인증은 `AccessToken` 헤더(플러그인에서 처리).
 *
 * 주소록 id 는 uuid 이므로 숫자 id 를 쓰던 곳에서 옮겨올 땐 매핑이 필요하다.
 */
export async function compatRoutes(app: FastifyInstance) {
  app.post('/v1/lists/:listId/subscribers', async (req) => {
    requireWrite(req);
    const { listId } = req.params as { listId: string };
    const b = (req.body ?? {}) as Record<string, any>;
    const list = await resolveList(listId);
    if (!list) return { Ok: false, Error: { Code: 'NOT_FOUND', Message: '주소록을 찾을 수 없습니다.' }, Value: null };

    const by = b.eventOccuredBy === 'SUBSCRIBER' ? 'SUBSCRIBER' : 'MANUAL';
    const pending = String(b.confirmEmailYN ?? 'N').toUpperCase() === 'Y';
    const groupIds: string[] = Array.isArray(b.groupIds) ? b.groupIds.map(String) : [];

    const subscribers: any[] = Array.isArray(b.subscribers) ? b.subscribers : [];
    const results = [];
    for (const s of subscribers) {
      const { email, $ad_agreed, ad_agreed, ...fields } = s;
      results.push(
        await upsertSubscriber(list.id, {
          email,
          fields,
          adAgreed: yn($ad_agreed ?? ad_agreed),
          groupIds,
          source: 'api',
          by,
          pending,
        })
      );
    }

    return {
      Ok: true,
      Error: null,
      Value: {
        success: results.filter((r) => r.result !== 'skipped').map((r) => r.email),
        // 실패 건은 사유와 함께 돌려준다.
        failure: results
          .filter((r) => r.result === 'skipped')
          .map((r) => ({ email: r.email, reason: r.reason })),
      },
    };
  });

  app.delete('/v1/lists/:listId/subscribers', async (req) => {
    requireWrite(req);
    const { listId } = req.params as { listId: string };
    const list = await resolveList(listId);
    if (!list) return { Ok: false, Error: { Code: 'NOT_FOUND', Message: '주소록을 찾을 수 없습니다.' }, Value: null };
    const emails = normalizeEmails(req.body);
    const changed = await setStatus(list.id, emails, 'deleted');
    return { Ok: true, Error: null, Value: { deleted: changed } };
  });

  app.post('/v1/lists/:listId/subscribers/unsubscribe', async (req) => {
    requireWrite(req);
    const { listId } = req.params as { listId: string };
    const list = await resolveList(listId);
    if (!list) return { Ok: false, Error: { Code: 'NOT_FOUND', Message: '주소록을 찾을 수 없습니다.' }, Value: null };
    const emails = normalizeEmails(req.body);
    const changed = await setStatus(list.id, emails, 'unsubscribed');
    return { Ok: true, Error: null, Value: { unsubscribed: changed } };
  });
}

function normalizeEmails(body: unknown): string[] {
  if (Array.isArray(body)) return body.map((v) => normalizeEmail(typeof v === 'string' ? v : (v as any)?.email));
  const b = body as any;
  if (Array.isArray(b?.subscribers)) return b.subscribers.map((s: any) => normalizeEmail(s.email ?? s));
  if (typeof b?.email === 'string') return [normalizeEmail(b.email)];
  return [];
}

function yn(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return /^(y|yes|true|1)$/i.test(String(v));
}

/** uuid 든 slug 든 받아준다 — 이관 중에는 slug 로 부르는 쪽이 편하다. */
async function resolveList(idOrSlug: string) {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrSlug)
    ? await one<{ id: string }>('select id from lists where id = $1', [idOrSlug])
    : null;
  if (byId) return byId;
  return one<{ id: string }>('select id from lists where slug = $1', [idOrSlug]);
}
