import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { currentUserId, requireWrite } from '../auth/plugin.js';
import { config } from '../config.js';

/**
 * 이메일에 넣을 이미지.
 *
 * 받는 사람의 메일 클라이언트가 부르는 주소라 공개 경로(/a/)로 서빙한다.
 * 내용 주소(sha256)로 중복을 제거하고, 한 번 올라간 바이트는 바뀌지 않으므로
 * immutable 캐시를 건다.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export async function assetRoutes(app: FastifyInstance) {
  app.post('/api/assets', async (req) => {
    requireWrite(req);
    const file = await (req as any).file({ limits: { fileSize: MAX_BYTES } });
    if (!file) throw badRequest('파일이 없습니다.');

    const mime = String(file.mimetype || '').toLowerCase();
    if (!ALLOWED[mime]) {
      throw badRequest(`지원하지 않는 형식입니다: ${mime || '알 수 없음'} (PNG·JPEG·GIF·WebP·SVG)`);
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

    const row = await one<{ id: string }>(
      `insert into assets (filename, mime, bytes, sha256, width, height, data, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (sha256) do update set filename = assets.filename
       returning id`,
      [file.filename ?? `image.${ALLOWED[mime]}`, mime, data.length, sha, size?.width ?? null, size?.height ?? null, data, currentUserId(req)]
    );

    return { asset: { id: row!.id, url: `${config.publicUrl}/a/${row!.id}`, mime, bytes: data.length, ...size } };
  });

  app.get('/api/assets', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit) || 60, 200);
    const rows = await many(
      `select id, filename, mime, bytes, width, height, created_at from assets
        order by created_at desc limit ${limit}`
    );
    return { assets: rows.map((a: any) => ({ ...a, url: `${config.publicUrl}/a/${a.id}` })) };
  });

  app.delete('/api/assets/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    await query('delete from assets where id = $1', [id]);
    return { ok: true };
  });

  // ---- 공개 서빙 ----
  app.get('/a/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clean = id.replace(/\.[a-z0-9]+$/i, '');
    if (!/^[0-9a-f-]{36}$/i.test(clean)) throw notFound('이미지를 찾을 수 없습니다.');

    const row = await one<{ mime: string; data: Buffer; sha256: string }>(
      'select mime, data, sha256 from assets where id = $1',
      [clean]
    );
    if (!row) throw notFound('이미지를 찾을 수 없습니다.');

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

/** 매직바이트로 실제 형식을 알아낸다. 확장자나 Content-Type 은 믿지 않는다. */
function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // SVG 는 텍스트라 매직바이트가 없다 — 앞부분에 svg 루트가 있는지 본다.
  const head = b.subarray(0, 1024).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')) {
    return head.includes('<svg') ? 'image/svg+xml' : null;
  }
  return null;
}

/** 이미지 헤더만 읽어 크기를 뽑는다. 에디터가 폭을 맞출 때 쓴다. */
function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 중 DHT/DAC/RST 제외
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* 못 읽으면 크기 없이 간다 */
  }
  return null;
}
