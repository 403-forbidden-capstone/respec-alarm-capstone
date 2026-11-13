-- 서버 전환 스위치(M1) 원복 — pg_cron 명령을 M1 이전 모양으로 되돌림 (운영 조작 · 마이그레이션 아님)
-- 언제: M1 적용 뒤 30분 안에 net._http_response에 wake-check · alarm-roll 200이 안 보일 때 등 (서버_완결점 10절)
-- 어디서: Supabase 대시보드 → SQL Editor에 통째로 붙여 실행. 여러 번 실행해도 같은 결과
-- 효과: wake-check · alarm-roll · suggestion-generate가 private.invoke_edge_function(이름)을 바로 부름 = M1 이전과 똑같음. 제안 안전망 cron(18:15 KST)은 지움
-- 안 지우는 것: 표 server_routes · server_route_users · server_heartbeat, 함수 get_server_routes · private.run_job (추가만 한 것이라 둬도 해롭지 않음)
-- voice-auto-commit · friend-requests-expire · friend-records-purge는 M1이 안 건드렸으므로 여기서도 안 건드림
-- 다시 적용: server-switch-reapply.sql

select cron.schedule('wake-check', '*/5 * * * *', $cmd$select private.invoke_edge_function('wake-check')$cmd$);
select cron.schedule('alarm-roll', '*/5 * * * *', $cmd$select private.invoke_edge_function('alarm-roll')$cmd$);
select cron.schedule('suggestion-generate', '0 9 * * *', $cmd$select private.invoke_edge_function('suggestion-generate')$cmd$);

do $$
begin
  if exists (select 1 from cron.job where jobname = 'suggestion-generate-safety') then
    perform cron.unschedule('suggestion-generate-safety');
  end if;
end;
$$;
