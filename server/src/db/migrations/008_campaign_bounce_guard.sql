-- 캠페인별 반송 차단 기준. null 이면 전역 설정(MAILROOM_BOUNCE_GUARD), 0 이면 이 캠페인은 끈다.
-- 스티비에서 넘어온 명단처럼 '첫 발송이 곧 검증'인 캠페인은 멈추지 않고 끝까지 보내며
-- 반송을 기록하는 쪽이 낫다 — 반송된 주소는 어차피 차단 목록으로 들어간다.
alter table campaigns add column if not exists bounce_guard real;
