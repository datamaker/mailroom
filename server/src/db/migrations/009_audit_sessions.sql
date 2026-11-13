-- 세션 종류와 감사 기록.

-- 세션: 브라우저(web)와 CLI(cli)를 구분한다. 브라우저 세션은 유휴 24시간·최장 7일로
-- 미끄러지고, CLI 세션은 유휴 만료 없이 최장 7일이다(매일 다시 로그인하게 만들지 않으려고).
alter table sessions add column if not exists kind text not null default 'web';

-- 이미 발급된 세션(예전 14일짜리)도 새 규칙에 맞춘다: 발급 후 7일, 그리고 지금부터 24시간 안에
-- 한 번은 써야 이어진다. 기존 세션은 web/cli 를 구분할 수 없어 전부 web 으로 본다 —
-- 하루 넘게 안 쓴 CLI 는 한 번 다시 로그인해야 한다.
update sessions
   set expires_at = least(expires_at, created_at + interval '7 days', now() + interval '24 hours');

-- 누가 구독자 명단을 내보내거나 대량으로 읽었는지. 사고가 났을 때 "누가 가져갔나"에 답하려는 것.
create table if not exists audit_log (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  action        text not null,               -- subscribers.export | subscribers.bulk_read | campaign.*.export
  actor_user_id uuid,                        -- 사용자가 지워져도 기록은 남긴다(FK 없음)
  actor_email   text,
  api_key_id    uuid,
  api_key_name  text,
  list_id       uuid,
  campaign_id   uuid,
  row_count     int not null default 0,
  ip            text,
  detail        jsonb not null default '{}'
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
create index if not exists audit_log_list_idx on audit_log (list_id, created_at desc);
