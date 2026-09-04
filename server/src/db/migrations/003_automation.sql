-- 자동 이메일: 구독·오픈·클릭·기념일 같은 사건에 반응해 나가는 메일.
-- 캠페인 테이블을 그대로 재사용하고(type='automation') 발동 조건만 따로 둔다.
alter table campaigns add column if not exists trigger jsonb not null default '{}';
-- 자동 이메일을 켠 시각. 켜기 전에 이미 있던 구독자에게 소급 발송하지 않기 위한 기준선.
alter table campaigns add column if not exists activated_at timestamptz;

create table if not exists automation_runs (
  id            bigserial primary key,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  -- 기념일처럼 해마다 반복되는 트리거를 구분한다. 일회성 트리거는 빈 문자열.
  cycle         text not null default '',
  status        text not null default 'scheduled',  -- scheduled | sent | skipped | failed
  scheduled_at  timestamptz not null,
  sent_at       timestamptz,
  recipient_id  bigint references campaign_recipients(id) on delete set null,
  error         text,
  created_at    timestamptz not null default now(),
  unique (campaign_id, subscriber_id, cycle)
);
create index if not exists automation_runs_due_idx
  on automation_runs (scheduled_at) where status = 'scheduled';
create index if not exists automation_runs_campaign_idx on automation_runs (campaign_id);
