/**
 * 외부에 얹혀 있는 이미지를 우리 저장소로 끌어온다.
 *
 * 이관해 온 뉴스레터는 이미지가 예전 서비스 CDN 을 가리킨다. 그쪽 계정을
 * 해지하면 지난 뉴스레터와 웹 아카이브가 전부 깨지므로, 바이트를 우리 쪽으로
 * 옮기고 본문 주소를 바꿔 둔다.
 *
 *   node server/dist/scripts/rehost-images.js            # 미리보기
 *   node server/dist/scripts/rehost-images.js --apply
 *   node server/dist/scripts/rehost-images.js --host img.example.com --apply
 *
 * 기본 대상은 예전 서비스 CDN 뿐이다. 파트너 배너처럼 남의 서버에 그대로
 * 두어야 하는 이미지를 건드리지 않으려고 호스트를 명시적으로 고른다.
 */
import { createHash } from 'node:crypto';
import { many, one, query } from '../db/pool.js';
import { publicUrlFor, put, type AssetRow } from '../storage/assets.js';
import { imageSize, sniff } from '../lib/image.js';

const DEFAULT_HOSTS = ['img.stibee.com', 'img2.stibee.com', 'image.stibee.com'];
const MAX_BYTES = 10 * 1024 * 1024;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hosts = new Set<string>(
  args.flatMap((a, i) => (a === '--host' ? [args[i + 1]] : [])).filter(Boolean).length
    ? args.flatMap((a, i) => (a === '--host' ? [args[i + 1]] : [])).filter(Boolean)
    : DEFAULT_HOSTS
);

function targets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^"'\\\s<>]+/g)) {
    try {
      if (hosts.has(new URL(m[0]).hostname)) out.add(m[0]);
    } catch {
      /* 주소가 아니면 넘어간다 */
    }
  }
  return [...out];
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 이미 가져온 주소는 다시 받지 않는다. */
const done = new Map<string, string>();

async function fetchAndStore(url: string): Promise<string> {
  const cached = done.get(url);
  if (cached) return cached;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) throw new Error('빈 응답');
  if (data.length > MAX_BYTES) throw new Error(`${Math.round(data.length / 1024)}KB — 너무 큼`);

  const mime =
    sniff(data) ?? MIME_BY_EXT[(url.split('.').pop() ?? '').toLowerCase().replace(/\?.*$/, '')] ?? null;
  if (!mime) throw new Error('이미지가 아님');

  const sha = createHash('sha256').update(data).digest('hex');
  const size = imageSize(data, mime);
  const filename = decodeURIComponent(url.split('/').pop() ?? 'image').replace(/\?.*$/, '');

  if (!apply) {
    done.set(url, `(새 주소)`);
    return `(새 주소)`;
  }

  const placed = await put(sha, mime, data);
  const row = await one<AssetRow>(
    `insert into assets (filename, mime, bytes, sha256, width, height, data, storage, object_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       -- 같은 파일을 다시 올리면 보관 위치를 지금 설정대로 맞춘다. sha 가 같으니
     -- 바이트는 동일하고, 표현만 db↔s3 로 옮겨 가는 셈이다.
     on conflict (sha256) do update set
       filename = assets.filename,
       storage = excluded.storage,
       object_key = excluded.object_key,
       data = excluded.data
     returning id, mime, storage, object_key`,
    [filename, mime, data.length, sha, size?.width ?? null, size?.height ?? null, placed.data, placed.storage, placed.objectKey]
  );
  const newUrl = publicUrlFor(row!);
  done.set(url, newUrl);
  return newUrl;
}

async function run() {
  console.log(`대상 호스트: ${[...hosts].join(', ')}`);
  console.log(apply ? '적용 모드' : '미리보기 — 적용하려면 --apply\n');

  let moved = 0;
  let failed = 0;

  // 발송된 캠페인은 content_html 스냅샷이 웹 아카이브로 나간다 — 그쪽도 같이 고친다.
  const sources = [
    { table: 'templates', columns: ['content'], json: ['content'] },
    { table: 'campaigns', columns: ['content', 'content_html'], json: ['content'] },
  ];

  for (const src of sources) {
    const cols = src.columns.map((c) => `${c}::text as ${c}`).join(', ');
    const rows = await many<Record<string, any>>(
      `select id, coalesce(name, id::text) as name, ${cols} from ${src.table} order by created_at`
    );
    for (const row of rows) {
      const sets: string[] = [];
      const params: unknown[] = [row.id];
      let label = false;

      for (const col of src.columns) {
        const text0: string | null = row[col];
        if (!text0) continue;
        const urls = targets(text0);
        if (!urls.length) continue;

        if (!label) {
          console.log(`${src.table} · ${row.name}`);
          label = true;
        }
        console.log(`  ${col}: 이미지 ${urls.length}개`);

        let text = text0;
        for (const url of urls) {
          try {
            const to = await fetchAndStore(url);
            text = text.split(url).join(to);
            moved++;
            console.log(`    ✓ ${url.slice(0, 66)}\n      → ${to}`);
          } catch (e: any) {
            failed++;
            console.log(`    ✗ ${url.slice(0, 66)} — ${e.message}`);
          }
        }
        if (apply && text !== text0) {
          if (src.json.includes(col)) JSON.parse(text); // 형태가 깨지지 않았는지 확인
          params.push(text);
          sets.push(`${col} = $${params.length}${src.json.includes(col) ? '::jsonb' : ''}`);
        }
      }

      if (sets.length) {
        await query(`update ${src.table} set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
      }
    }
  }

  console.log(`\n옮김 ${moved}개, 실패 ${failed}개`);
  if (!apply) console.log('아직 아무것도 바꾸지 않았습니다.');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
