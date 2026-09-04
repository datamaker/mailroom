-- 워커가 배치를 집어간 시각. 죽은 워커를 되돌릴 때 created_at 대신 이걸 본다.
-- (created_at 은 발송 준비 시각이라, 30분짜리 대량 발송에서는 정상 진행 중인
--  행까지 오래된 것으로 보여 되돌려지고 → 같은 사람에게 두 번 나간다.)
alter table campaign_recipients add column if not exists sending_at timestamptz;
create index if not exists campaign_recipients_sending_idx
  on campaign_recipients (sending_at) where status = 'sending';
