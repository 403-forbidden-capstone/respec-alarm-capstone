-- 서버 전환 스위치(M1) 다시 적용 — 원복(server-switch-rollback.sql)한 뒤 pg_cron 명령을 M1 모양으로 되돌림 (운영 조작 · 마이그레이션 아님)
-- 어디서: Supabase 대시보드 → SQL Editor에 통째로 붙여 실행. 여러 번 실행해도 같은 결과
-- 전제: M1 마이그레이션(20261113100000_server_switch.sql)이 이미 적용돼 private.run_job이 있음
-- 효과: wake-check · alarm-roll · suggestion-generate가 run_job을 부르고, 제안 안전망 cron(18:15 KST)이 다시 생김
-- 이 파일의 cron 문 네 줄은 마이그레이션 6절과 같아야 함 (supabase/tests가 같은지 확인)
-- 끝에 cron.job 목록을 보여 줌: 같은 jobname이 username 다르게 두 줄이면 교체가 아니라 추가된 것 → 알림

select cron.schedule('wake-check', '*/5 * * * *', $cmd$select private.run_job('wake-check')$cmd$);
select cron.schedule('alarm-roll', '*/5 * * * *', $cmd$select private.run_job('alarm-roll')$cmd$);
select cron.schedule('suggestion-generate', '0 9 * * *', $cmd$select private.run_job('suggestion-generate', 'primary')$cmd$);
select cron.schedule('suggestion-generate-safety', '15 9 * * *', $cmd$select private.run_job('suggestion-generate', 'safety')$cmd$);

select jobid, jobname, username, schedule, command, active from cron.job order by jobname;
