-- 반송 차단기가 '이번 발송 구간'만 보도록 기준 시각을 둔다.
-- 없으면 캠페인 누적 비율을 보게 되어, 한 번 멈춘 캠페인은 명단을 정리해도
-- 재개하자마자 다시 멈춘다 (옛 반송이 분자에 그대로 남는다).
alter table campaigns add column if not exists guard_since timestamptz;
