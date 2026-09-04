import { config } from '../config.js';
import { many, one, query } from '../db/pool.js';
import { prepareCampaign, sendCampaignBatch } from '../send/campaign.js';
import { randomToken } from '../lib/crypto.js';

const WORKER_ID = `${process.pid}-${randomToken(4)}`;

export interface Job {
  id: number;
  kind: string;
  campaign_id: string | null;
  payload: Record<string, any>;
  attempts: number;
}

export async function enqueue(kind: string, campaignId: string | null, payload: Record<string, unknown> = {}, runAt?: Date) {
  const row = await one<{ id: number }>(
    `insert into send_jobs (kind, campaign_id, payload, run_at)
     values ($1, $2, $3, coalesce($4, now()))
     returning id`,
    [kind, campaignId, payload, runAt ?? null]
  );
  return row!.id;
}

async function claim(): Promise<Job | null> {
  const { rows } = await query<Job>(
    `update send_jobs
        set status = 'running', locked_at = now(), locked_by = $1,
            attempts = attempts + 1, updated_at = now()
      where id = (
        select id from send_jobs
         where status = 'pending' and run_at <= now()
         order by run_at
         for update skip locked
         limit 1
      )
      returning id, kind, campaign_id, payload, attempts`,
    [WORKER_ID]
  );
  return rows[0] ?? null;
}

async function finish(id: number, status: 'done' | 'failed' | 'pending', error?: string, runAt?: Date) {
  await query(
    `update send_jobs set status = $2, last_error = $3, run_at = coalesce($4, run_at),
            locked_at = null, locked_by = null, updated_at = now()
      where id = $1`,
    [id, status, error ?? null, runAt ?? null]
  );
}

const MAX_ATTEMPTS = 5;

async function runJob(job: Job) {
  switch (job.kind) {
    case 'send_campaign': {
      // 준비는 멱등하지 않게 두 번 돌면 곤란하니 상태로 가드한다.
      const c = await one<{ status: string }>('select status from campaigns where id = $1', [job.campaign_id]);
      if (!c) return;
      if (c.status === 'canceled' || c.status === 'paused' || c.status === 'sent') return;
      // 수신자 스냅샷이 아직 없을 때만 준비한다 — 재개/재시도 시 명단이 갈리지 않도록.
      const existing = await one<{ count: number }>(
        'select count(*)::int as count from campaign_recipients where campaign_id = $1',
        [job.campaign_id]
      );
      if (!existing?.count) await prepareCampaign(job.campaign_id!);
      await enqueue('send_batch', job.campaign_id, {});
      return;
    }

    case 'send_batch': {
      const c = await one<{ status: string }>('select status from campaigns where id = $1', [job.campaign_id]);
      if (!c || c.status === 'canceled' || c.status === 'paused') return;
      const res = await sendCampaignBatch(job.campaign_id!);
      if (res.remaining > 0) {
        // 다음 배치를 바로 이어서 — 레이트리밋은 배치 안에서 이미 걸린다.
        await enqueue('send_batch', job.campaign_id, {});
      }
      return;
    }

    default:
      throw new Error(`알 수 없는 작업 종류: ${job.kind}`);
  }
}

/** 예약 시각이 지난 캠페인을 큐에 넣는다. */
async function promoteScheduled() {
  const due = await many<{ id: string }>(
    `update campaigns
        set status = 'sending', updated_at = now()
      where status = 'scheduled' and scheduled_at <= now()
      returning id`
  );
  for (const c of due) await enqueue('send_campaign', c.id);
}

/** 워커가 죽어 'sending'에 갇힌 수신자를 되돌린다. */
async function reapStuckRecipients() {
  // sending_at 기준이어야 한다 — created_at 은 발송 준비 시각이라 긴 발송에서
  // 정상 진행 중인 배치까지 되돌려 같은 사람에게 두 번 나간다.
  await query(
    `update campaign_recipients
        set status = 'queued', sending_at = null
      where status = 'sending' and sent_at is null
        and coalesce(sending_at, created_at) < now() - interval '15 minutes'`
  );
  await query(
    `update send_jobs set status = 'pending', locked_at = null, locked_by = null
      where status = 'running' and locked_at < now() - interval '15 minutes'`
  );
}

let stopped = false;

export function startWorker() {
  if (!config.worker.enabled) {
    console.log('[worker] 비활성화됨 (MAILROOM_WORKER=0)');
    return;
  }
  console.log(`[worker] 시작 ${WORKER_ID} (rate=${config.send.rateLimit}/s, batch=${config.send.batchSize})`);

  const loop = async () => {
    while (!stopped) {
      try {
        await promoteScheduled();
        const job = await claim();
        if (!job) {
          await sleep(config.worker.pollMs);
          continue;
        }
        try {
          await runJob(job);
          await finish(job.id, 'done');
        } catch (err) {
          const message = (err as Error).message?.slice(0, 500) ?? 'unknown';
          if (job.attempts >= MAX_ATTEMPTS) {
            await finish(job.id, 'failed', message);
            if (job.campaign_id) {
              await query(`update campaigns set status = 'failed' where id = $1 and status = 'sending'`, [
                job.campaign_id,
              ]);
            }
            console.error(`[worker] job ${job.id} (${job.kind}) 최종 실패: ${message}`);
          } else {
            const backoff = new Date(Date.now() + Math.min(60_000, 2 ** job.attempts * 1000));
            await finish(job.id, 'pending', message, backoff);
            console.warn(`[worker] job ${job.id} 재시도 ${job.attempts}/${MAX_ATTEMPTS}: ${message}`);
          }
        }
      } catch (err) {
        console.error('[worker] 루프 오류', err);
        await sleep(5000);
      }
    }
  };

  loop();
  const reaper = setInterval(() => reapStuckRecipients().catch(() => {}), 60_000);
  reaper.unref?.();
}

export function stopWorker() {
  stopped = true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
