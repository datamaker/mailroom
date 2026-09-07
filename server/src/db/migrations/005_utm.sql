-- 발송 시 링크에 붙일 UTM. 캠페인별 설정이 없으면 settings 의 기본값을 쓴다.
alter table campaigns add column if not exists utm jsonb;

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('utm', '{"enabled":true,"source":"newsletter","medium":"email","campaign":"","mode":"overwrite"}')
on conflict (key) do nothing;
