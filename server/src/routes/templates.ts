import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { currentUserId, requireWrite } from '../auth/plugin.js';
import { renderEmailHtml } from '../render/html.js';
import { importEmailHtml } from '../render/import-html.js';

export async function templateRoutes(app: FastifyInstance) {
  app.get('/api/templates', async () => ({
    templates: await many(
      `select id, name, is_builtin, created_at, updated_at,
              jsonb_array_length(content) as block_count
         from templates order by is_builtin desc, updated_at desc`
    ),
  }));

  app.get('/api/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    const template = await one('select * from templates where id = $1', [id]);
    if (!template) throw notFound('템플릿을 찾을 수 없습니다.');
    return { template };
  });

  app.get('/api/templates/:id/html', async (req) => {
    const { id } = req.params as { id: string };
    const t = await one<any>('select content, styles from templates where id = $1', [id]);
    if (!t) throw notFound('템플릿을 찾을 수 없습니다.');
    return { html: renderEmailHtml(t.content ?? [], { styles: t.styles }) };
  });

  app.post('/api/templates', async (req) => {
    requireWrite(req);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.name) throw badRequest('템플릿 이름이 필요합니다.');
    const template = await one(
      `insert into templates (name, content, styles, created_by)
       values ($1, coalesce($2::jsonb,'[]'::jsonb), coalesce($3::jsonb,'{}'::jsonb), $4) returning *`,
      [b.name, b.content ? JSON.stringify(b.content) : null, b.styles ? JSON.stringify(b.styles) : null, currentUserId(req)]
    );
    return { template };
  });

  /** 발송한 이메일을 그대로 템플릿으로 저장 */
  app.post('/api/templates/from-campaign/:campaignId', async (req) => {
    requireWrite(req);
    const { campaignId } = req.params as { campaignId: string };
    const b = (req.body ?? {}) as Record<string, any>;
    const c = await one<any>('select subject, content, styles from campaigns where id = $1', [campaignId]);
    if (!c) throw notFound('이메일을 찾을 수 없습니다.');
    const template = await one(
      `insert into templates (name, content, styles, created_by) values ($1,$2::jsonb,$3::jsonb,$4) returning *`,
      [b.name || c.subject || '이름 없는 템플릿', JSON.stringify(c.content), JSON.stringify(c.styles), currentUserId(req)]
    );
    return { template };
  });

  /** 내보낸 이메일 HTML 을 블록으로 되돌려 템플릿으로 저장 */
  app.post('/api/templates/import', async (req) => {
    requireWrite(req);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.html) throw badRequest('html 본문이 필요합니다.');
    const { blocks, rawCount, images } = importEmailHtml(b.html);
    if (!blocks.length) throw badRequest('상자를 하나도 인식하지 못했습니다.');
    const template = await one(
      `insert into templates (name, content, created_by) values ($1, $2::jsonb, $3) returning *`,
      [b.name || '가져온 템플릿', JSON.stringify(blocks), currentUserId(req)]
    );
    return { template, stats: { blocks: blocks.length, rawCount, images: images.length } };
  });

  app.patch('/api/templates/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, any>;
    const template = await one(
      `update templates
          set name = coalesce($2, name),
              content = coalesce($3::jsonb, content),
              styles = coalesce($4::jsonb, styles),
              updated_at = now()
        where id = $1 returning *`,
      [id, b.name ?? null, b.content ? JSON.stringify(b.content) : null, b.styles ? JSON.stringify(b.styles) : null]
    );
    if (!template) throw notFound('템플릿을 찾을 수 없습니다.');
    return { template };
  });

  app.delete('/api/templates/:id', async (req) => {
    requireWrite(req);
    const { id } = req.params as { id: string };
    await query('delete from templates where id = $1 and not is_builtin', [id]);
    return { ok: true };
  });
}
