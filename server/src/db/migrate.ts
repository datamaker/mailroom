import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  await pool.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  // dist/ 에서는 마이그레이션이 src 옆에 복사돼 있고, tsx 실행 시엔 src 안에 있다.
  const dir = join(here, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('._'))
    .sort();

  const done = new Set(
    (await pool.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name)
  );

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
