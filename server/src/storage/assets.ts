import { config } from '../config.js';

/**
 * 이미지 바이트를 어디에 둘지 감춘다.
 *
 * 'db' 는 Postgres 의 bytea, 's3' 는 버킷. 둘 다 `/a/<id>` 주소로 열리므로
 * 보관 위치를 바꿔도 이미 발송된 메일의 이미지는 살아 있다.
 * S3 인 경우 본문에는 CDN 주소를 직접 박아 발송 때 우리 서버로 트래픽이 몰리지 않게 한다.
 */

export interface AssetRow {
  id: string;
  mime: string;
  storage: string;
  object_key: string | null;
  data?: Buffer | null;
}

export interface Placed {
  storage: 'db' | 's3';
  objectKey: string | null;
  data: Buffer | null;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

let client: any = null;

async function s3() {
  if (!client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    client = new S3Client({ region: config.assets.region });
  }
  return client;
}

export function s3Enabled(): boolean {
  return config.assets.store === 's3' && Boolean(config.assets.bucket);
}

/** 내용이 같으면 키도 같다 — 중복 업로드가 같은 자리를 덮어써도 무해하다. */
export function objectKeyFor(sha: string, mime: string): string {
  const ext = EXT[mime] ?? 'bin';
  return `${config.assets.prefix}/${sha.slice(0, 2)}/${sha}.${ext}`;
}

export async function put(sha: string, mime: string, data: Buffer): Promise<Placed> {
  if (!s3Enabled()) return { storage: 'db', objectKey: null, data };

  const key = objectKeyFor(sha, mime);
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(
    new PutObjectCommand({
      Bucket: config.assets.bucket,
      Key: key,
      Body: data,
      ContentType: mime,
      // 키가 내용 해시라 바이트가 바뀌면 주소도 바뀐다 — 영구 캐시해도 안전하다.
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return { storage: 's3', objectKey: key, data: null };
}

export async function remove(row: AssetRow): Promise<void> {
  if (row.storage !== 's3' || !row.object_key) return;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new DeleteObjectCommand({ Bucket: config.assets.bucket, Key: row.object_key }));
}

/** S3 에 올라간 이미지의 공개 주소. */
export function cdnUrl(objectKey: string): string {
  const base =
    config.assets.baseUrl || `https://${config.assets.bucket}.s3.${config.assets.region}.amazonaws.com`;
  return `${base}/${objectKey}`;
}

/** 본문에 박을 주소. */
export function publicUrlFor(row: AssetRow): string {
  if (row.storage === 's3' && row.object_key) return cdnUrl(row.object_key);
  return `${config.publicUrl}/a/${row.id}`;
}
