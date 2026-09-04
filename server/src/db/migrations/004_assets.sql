-- 이메일에 넣는 이미지. 뉴스레터 이미지는 개당 수백 KB에 개수도 많지 않아
-- 별도 스토리지를 붙이는 대신 DB에 담는다 — 백업·복제가 DB와 함께 가고
-- 컨테이너를 갈아끼워도 볼륨을 신경 쓸 일이 없다.
create table if not exists assets (
  id         uuid primary key default gen_random_uuid(),
  filename   text not null,
  mime       text not null,
  bytes      int not null,
  sha256     text not null,
  width      int,
  height     int,
  data       bytea not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
-- 같은 파일을 여러 번 올려도 하나만 남긴다.
create unique index if not exists assets_sha_key on assets (sha256);
