/**
 * DB(bytea)에 있는 이미지를 S3 로 옮긴다.
 *
 * 보관 위치를 바꾼 뒤 이미 들어와 있던 것들을 따라 올리는 용도다.
 * `/a/<id>` 주소는 그대로라 이미 발송된 메일과 웹 아카이브는 손댈 필요가 없다 —
 * 옮기고 나면 그 주소가 CDN 으로 301 한다.
 *
 *   node server/dist/scripts/move-assets.js          # 미리보기
 *   node server/dist/scripts/move-assets.js --apply
 *
 * --rewrite-content 를 같이 주면 템플릿·캠페인 본문의 /a/<id> 를 CDN 주소로 바꾼다.
 * 안 바꿔도 동작은 하지만, 3만 명에게 보내면 이미지마다 우리 서버를 한 번씩
 * 거치게 된다. 발송 스냅샷(content_html)은 그대로 둔다 — 그건 실제로 나간 내용이다.
 */
import { config } from '../config.js';
import { many, query } from '../db/pool.js';
import { cdnUrl, put, s3Enabled } from '../storage/assets.js';

const apply = process.argv.includes('--apply');
const rewrite = process.argv.includes('--rewrite-content');

async function run() {
  if (!s3Enabled()) {
    console.error('S3 보관이 꺼져 있습니다. MAILROOM_ASSET_STORE=s3 와 버킷을 설정하세요.');
    process.exit(1);
  }

  const rows = await many<{ id: string; filename: string; mime: string; sha256: string; data: Buffer }>(
    `select id, filename, mime, sha256, data from assets where storage = 'db' and data is not null
      order by created_at`
  );
  console.log(`버킷 ${config.assets.bucket}/${config.assets.prefix}`);
  console.log(`옮길 이미지 ${rows.length}개${apply ? '' : ' — 미리보기, 적용하려면 --apply'}\n`);

  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (!apply) {
        console.log(`  · ${row.filename} → ${cdnUrl(`${config.assets.prefix}/${row.sha256.slice(0, 2)}/${row.sha256}`)}…`);
        continue;
      }
      const placed = await put(row.sha256, row.mime, row.data);
      // 바이트를 지우기 전에 S3 쓰기가 끝난 걸 확인한 뒤에만 행을 바꾼다.
      await query(`update assets set storage = $2, object_key = $3, data = null where id = $1`, [
        row.id,
        placed.storage,
        placed.objectKey,
      ]);
      moved++;
      console.log(`  ✓ ${row.filename} → ${cdnUrl(placed.objectKey!)}`);
    } catch (e: any) {
      failed++;
      console.log(`  ✗ ${row.filename} — ${e.message}`);
    }
  }

  if (apply) console.log(`\n옮김 ${moved}개, 실패 ${failed}개`);

  if (rewrite) {
    console.log('\n본문의 /a/<id> 를 CDN 주소로 바꿉니다.');
    const onS3 = await many<{ id: string; object_key: string }>(
      `select id, object_key from assets where storage = 's3' and object_key is not null`
    );
    let changed = 0;
    for (const table of ['templates', 'campaigns'] as const) {
      const rows = await many<{ id: string; content: string }>(
        `select id, content::text as content from ${table}`
      );
      for (const row of rows) {
        let text = row.content;
        for (const a of onS3) {
          text = text.split(`${config.publicUrl}/a/${a.id}`).join(cdnUrl(a.object_key));
        }
        if (text === row.content) continue;
        changed++;
        if (apply) {
          JSON.parse(text); // 형태가 깨지지 않았는지 확인
          await query(`update ${table} set content = $2::jsonb, updated_at = now() where id = $1`, [row.id, text]);
        }
      }
    }
    console.log(apply ? `본문 ${changed}건 갱신` : `본문 ${changed}건이 바뀝니다 (--apply 필요)`);
  }

  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
