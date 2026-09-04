import pg from 'pg';
import { config } from '../config.js';

// 발송 통계 집계에서 bigint(count)가 문자열로 오는 걸 막는다.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // 발송 워커가 물고 늘어지는 커넥션을 방치하지 않는다.
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
