-- 준비 시간 학습 표본에서 이상값을 뺌 (결정 D107 A)
--
-- 근거
--   · 결정 D107 A · PR #240 리뷰(10/29). 저녁 약속만 있는 날 아침에 잠깐 나간 출발을 17:00 재출발이 덮으면
--     기상~출발 600분짜리 값이 daily_records.actual_prepare_minutes에 들어가 P80이 크게 늘 수 있음.
--     (이동시간에는 60분 창 방어가 있는데 준비 시간에는 상한이 없었음)
--   · 기록(daily_records)은 그대로 두고 학습 표본(이 뷰)에서만 뺌. 기상~출발 240분(4시간) 넘는 값은 표본에 안 셈.
--   · 240은 근거 없음 — 작성자 판단. 지형님 메모로 바뀔 수 있음 (바꾸면 이 뷰만 새 마이그레이션으로 다시 정의).
--
-- 바뀌는 것: v_prepare_time_stats의 where에 `actual_prepare_minutes <= 240`만 더함. 열 이름 · 순서 · 타입은 그대로.
-- 권한: create or replace view는 소유자 · 기존 권한(grant/revoke)을 그대로 두므로
--       20261007000200_rls.sql의 revoke(insert/update/delete)가 유지됨. 아래 revoke는 같은 문장을 다시 적은 것(중복이어도 무해).

create or replace view public.v_prepare_time_stats
with (security_invoker = true)
as
select user_id,
       count(*)                                                           as sample_count,
       percentile_cont(0.8) within group (order by actual_prepare_minutes) as p80_minutes
from public.daily_records
where actual_prepare_minutes is not null
  and actual_prepare_minutes <= 240
group by user_id;

revoke insert, update, delete on public.v_prepare_time_stats from authenticated, service_role;
