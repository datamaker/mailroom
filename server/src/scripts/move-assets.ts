/**
 * DB(bytea)에 있는 이미지를 S3 로 옮긴다.
 *
 * 보관 위치를 바꾼 뒤 이미 들어와 있던 것들을 따라 올리는 용도다.
 * `/a/<id>` 주소는 그대로라 이미 발송된 메일과 웹 아카이브는 손댈 필요가 없다 —
 * 옮기고 나면 그 주소가 CDN 으로 301 한다.
 *
 *   node server/dist/scripts/move-assets.js          # 미리보기
 *   node server/dist/scripts/move-assets.js --apply
 */
import { config } from '../config.js';
import { many, query } from '../db/pool.js';
import { cdnUrl, put, s3Enabled } from '../storage/assets.js';

const apply = process.argv.includes('--apply');

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
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
