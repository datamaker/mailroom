import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { currentUserId, requireWrite } from '../auth/plugin.js';
import { config } from '../config.js';
import { cdnUrl, publicUrlFor, put, remove, type AssetRow } from '../storage/assets.js';
import { imageSize, sniff } from '../lib/image.js';

/**
 * 이메일에 넣을 이미지.
 *
 * 받는 사람의 메일 클라이언트가 부르는 주소라 공개 경로(/a/)로 서빙한다.
 * 내용 주소(sha256)로 중복을 제거하고, 한 번 올라간 바이트는 바뀌지 않으므로
 * immutable 캐시를 건다.
 */

const MAX_BYTES = 5 * 1024 * 1024;
// SVG 는 넣지 않는다. Gmail·Outlook 이 어차피 걸러 내는데, 주소로 직접 열면
// 스크립트가 도는 저장형 XSS 통로만 남는다.
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function assetRoutes(app: FastifyInstance) {
  app.post('/api/assets', async (req) => {
    requireWrite(req);
    const file = await (req as any).file({ limits: { fileSize: MAX_BYTES } });
    if (!file) throw badRequest('파일이 없습니다.');

    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED[mime]) {
      throw badRequest(`지원하지 않는 형식입니다: ${mime || '알 수 없음'} (PNG·JPEG·GIF·WebP)`);
    }

    const data: Buffer = await file.toBuffer();
    if (file.file.truncated || data.length > MAX_BYTES) {
      throw badRequest(`파일이 너무 큽니다. ${Math.round(MAX_BYTES / 1024 / 1024)}MB 이하만 올릴 수 있습니다.`);
    }
    if (!data.length) throw badRequest('빈 파일입니다.');

    // 클라이언트가 보낸 Content-Type 은 얼마든지 위조된다. 실제 바이트로 확인한다.
    const actual = sniff(data);
    if (!actual) throw badRequest('이미지 파일이 아닙니다.');
    if (actual !== mime) {
      throw badRequest(`파일 내용이 ${mime} 이 아닙니다(실제: ${actual}).`);
    }

    const sha = createHash('sha256').update(data).digest('hex');
    const size = imageSize(data, mime);
    // 자리를 먼저 잡는다 — S3 업로드가 실패하면 DB 에 반쪽 행을 남기지 않는다.
    const placed = await put(sha, mime, data);

    const row = await one<AssetRow>(
      `insert into assets (filename, mime, bytes, sha256, width, height, data, storage, object_key, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       -- 같은 파일을 다시 올리면 보관 위치를 지금 설정대로 맞춘다. sha 가 같으니
       -- 바이트는 동일하고, 표현만 db↔s3 로 옮겨 가는 셈이다.
       on conflict (sha256) do update set
         filename = assets.filename,
         storage = excluded.storage,
         object_key = excluded.object_key,
         data = excluded.data
       returning id, mime, storage, object_key`,
      [
        file.filename ?? `image.${ALLOWED[mime]}`,
        mime,
        data.length,
        sha,
        size?.width ?? null,
        size?.height ?? null,
        placed.data,
        placed.storage,
        placed.objectKey,
        currentUserId(req),
      ]
    );

    return { asset: { id: row!.id, url: publicUrlFor(row!), mime, bytes: data.length, ...size } };
  });

  app.get('/api/assets', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit) || 60, 200);
    const rows = await many<AssetRow & Record<string, any>>(
      `select id, filename, mime, bytes, width, height, storage, object_key, created_at from assets
        order by created_at desc limit ${limit}`
    );
    return { assets: rows.map((a) => ({ ...a, url: publicUrlFor(a) })) };
  });

  app.delete('/api/assets/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const row = await one<AssetRow>('select id, mime, storage, object_key from assets where id = $1', [id]);
    if (row) await remove(row);
    await query('delete from assets where id = $1', [id]);
    return { ok: true };
  });

  // ---- 공개 서빙 ----
  app.get('/a/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clean = id.replace(/\.[a-z0-9]+$/i, '');
    if (!/^[0-9a-f-]{36}$/i.test(clean)) throw notFound('이미지를 찾을 수 없습니다.');

    const row = await one<{ mime: string; data: Buffer | null; sha256: string; storage: string; object_key: string | null }>(
      'select mime, data, sha256, storage, object_key from assets where id = $1',
      [clean]
    );
    if (!row) throw notFound('이미지를 찾을 수 없습니다.');

    // S3 로 옮긴 뒤에도 이미 발송된 메일은 이 주소를 부른다 — CDN 으로 넘긴다.
    if (row.storage === 's3' && row.object_key) {
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.redirect(301, cdnUrl(row.object_key));
    }
    if (!row.data) throw notFound('이미지를 찾을 수 없습니다.');

    const etag = `"${row.sha256.slice(0, 32)}"`;
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();

    reply.header('content-type', row.mime);
    reply.header('etag', etag);
    // SVG 는 스크립트를 품을 수 있다. <img> 로 불릴 땐 실행되지 않지만 주소로 직접 열면
    // 실행되므로, 어떤 리소스도 불러오지 못하게 막고 스니핑도 끈다.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('x-content-type-options', 'nosniff');
    // 내용이 바뀌면 id 도 바뀐다 — 영구 캐시해도 안전하다.
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(row.data);
  });
}
