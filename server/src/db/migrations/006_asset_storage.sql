-- 이미지를 S3 로도 보관할 수 있게 한다. 기존 행은 전부 'db' 로 남는다.
alter table assets add column if not exists storage    text not null default 'db';
alter table assets add column if not exists object_key text;
alter table assets alter column data drop not null;

-- 보관 위치가 어디든 무결성은 지킨다.
alter table assets drop constraint if exists assets_storage_ck;
alter table assets add constraint assets_storage_ck check (
  (storage = 'db' and data is not null) or
  (storage = 's3' and object_key is not null)
);
