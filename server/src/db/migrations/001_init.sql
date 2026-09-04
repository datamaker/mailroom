-- mailroom initial schema

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text,
  role          text not null default 'member',      -- owner | admin | member
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  key_hash     text not null unique,
  key_prefix   text not null,
  scopes       text[] not null default '{read,write}',
  is_active    boolean not null default true,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- 발신자 주소 (워크스페이스 공통)
create table if not exists senders (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  name       text,
  verified   boolean not null default false,
  spf        boolean,
  dkim       boolean,
  dmarc      boolean,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists senders_email_key on senders (lower(email));

-- 주소록
create table if not exists lists (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  slug                    text not null unique,
  default_sender_name     text,
  default_sender_email    text,
  sender_emails           text[] not null default '{}',
  footer_company          text,
  footer_address          text,
  footer_phone            text,
  auto_delete_hard_bounce boolean not null default false,
  allow_unsubscribed_send boolean not null default false,
  form_enabled            boolean not null default true,
  form_language           text not null default 'ko',
  double_optin            boolean not null default true,
  form_title              text,
  form_description        text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists custom_fields (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references lists(id) on delete cascade,
  key           text not null,
  label         text not null,
  type          text not null default 'text',        -- text | number | date | datetime | select
  options       jsonb,
  default_value text,
  required      boolean not null default false,
  is_system     boolean not null default false,
  show_on_form  boolean not null default true,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  unique (list_id, key)
);

create table if not exists subscribers (
  id              uuid primary key default gen_random_uuid(),
  list_id         uuid not null references lists(id) on delete cascade,
  email           text not null,
  status          text not null default 'subscribed', -- subscribed | unsubscribed | deleted | pending
  ad_agreed       boolean not null default false,
  fields          jsonb not null default '{}',
  source          text,                               -- form | api | import | manual
  subscribed_at   timestamptz not null default now(),
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists subscribers_list_email_key on subscribers (list_id, lower(email));
create index if not exists subscribers_list_status_idx on subscribers (list_id, status);
create index if not exists subscribers_fields_idx on subscribers using gin (fields);
create index if not exists subscribers_subscribed_at_idx on subscribers (list_id, subscribed_at);

create table if not exists groups (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references lists(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  unique (list_id, name)
);

create table if not exists subscriber_groups (
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  group_id      uuid not null references groups(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (subscriber_id, group_id)
);
create index if not exists subscriber_groups_group_idx on subscriber_groups (group_id);

create table if not exists segments (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references lists(id) on delete cascade,
  name       text not null,
  match      text not null default 'all',   -- all | any
  conditions jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (list_id, name)
);

create table if not exists templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  content    jsonb not null default '[]',
  styles     jsonb not null default '{}',
  is_builtin boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaigns (
  id                 uuid primary key default gen_random_uuid(),
  list_id            uuid references lists(id) on delete set null,
  name               text,
  subject            text not null default '',
  preheader          text,
  sender_name        text,
  sender_email       text,
  reply_to           text,
  type               text not null default 'regular',  -- regular | automation
  status             text not null default 'draft',    -- draft|scheduled|sending|sent|paused|failed|canceled
  content            jsonb not null default '[]',
  styles             jsonb not null default '{}',
  content_html       text,
  target             jsonb not null default '{}',
  tags               text[] not null default '{}',
  is_ad              boolean not null default false,
  track_opens        boolean not null default true,
  track_clicks       boolean not null default true,
  scheduled_at       timestamptz,
  send_started_at    timestamptz,
  send_finished_at   timestamptz,
  public_slug        text unique,
  public_visibility  text not null default 'private',  -- private | public
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  total_count        int not null default 0,
  sent_count         int not null default 0,
  failed_count       int not null default 0,
  open_count         int not null default 0,
  unique_open_count  int not null default 0,
  click_count        int not null default 0,
  unique_click_count int not null default 0,
  bounce_count       int not null default 0,
  complaint_count    int not null default 0,
  unsub_count        int not null default 0
);
create index if not exists campaigns_status_idx on campaigns (status);
create index if not exists campaigns_list_idx on campaigns (list_id);
create index if not exists campaigns_scheduled_idx on campaigns (scheduled_at) where status = 'scheduled';

create table if not exists campaign_recipients (
  id            bigserial primary key,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  subscriber_id uuid references subscribers(id) on delete set null,
  email         text not null,
  merge         jsonb not null default '{}',
  status        text not null default 'queued',  -- queued | sent | failed | bounced
  message_id    text,
  error         text,
  sent_at       timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  open_count    int not null default 0,
  click_count   int not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists campaign_recipients_uniq on campaign_recipients (campaign_id, email);
create index if not exists campaign_recipients_pending_idx on campaign_recipients (campaign_id) where status = 'queued';
create index if not exists campaign_recipients_msgid_idx on campaign_recipients (message_id);

create table if not exists campaign_links (
  id                 bigserial primary key,
  campaign_id        uuid not null references campaigns(id) on delete cascade,
  url                text not null,
  label              text,
  click_count        int not null default 0,
  unique_click_count int not null default 0,
  unique (campaign_id, url)
);

create table if not exists events (
  id            bigserial primary key,
  campaign_id   uuid references campaigns(id) on delete cascade,
  recipient_id  bigint references campaign_recipients(id) on delete cascade,
  subscriber_id uuid references subscribers(id) on delete set null,
  link_id       bigint references campaign_links(id) on delete set null,
  type          text not null,   -- delivered | open | click | bounce | complaint | unsubscribe
  url           text,
  user_agent    text,
  ip            text,
  device        text,            -- mobile | desktop | unknown
  os            text,            -- ios | android | windows | macos | ...
  client        text,            -- gmail | outlook | apple-mail | other
  meta          jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists events_campaign_type_idx on events (campaign_id, type);
create index if not exists events_created_idx on events (created_at);
create index if not exists events_subscriber_idx on events (subscriber_id);

create table if not exists suppressions (
  email      text primary key,
  reason     text not null,       -- hard_bounce | complaint | manual
  source     text,
  detail     text,
  created_at timestamptz not null default now()
);

create table if not exists send_jobs (
  id          bigserial primary key,
  kind        text not null,      -- send_campaign | send_batch | test_send | confirm_email
  campaign_id uuid references campaigns(id) on delete cascade,
  payload     jsonb not null default '{}',
  run_at      timestamptz not null default now(),
  status      text not null default 'pending',   -- pending | running | done | failed
  attempts    int not null default 0,
  last_error  text,
  locked_at   timestamptz,
  locked_by   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists send_jobs_claim_idx on send_jobs (status, run_at);

-- 구독 확인 / 수신거부 / 구독정보변경 링크용 일회성 토큰
create table if not exists subscriber_tokens (
  token         text primary key,
  list_id       uuid not null references lists(id) on delete cascade,
  subscriber_id uuid references subscribers(id) on delete cascade,
  kind          text not null,     -- confirm | preferences
  payload       jsonb not null default '{}',
  expires_at    timestamptz,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
