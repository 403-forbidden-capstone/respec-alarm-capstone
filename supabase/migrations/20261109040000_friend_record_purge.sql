-- =====================================================================
-- 친구 13장 — 서버 기록 7일 보관 (친구 논리설계 13장 13-카 · X-2, 11/8 확정). 이슈 #422
--   매일 한 번(새벽) 7일 지난 서버 기록을 지움:
--     · 제한 · 코드 실패 기록 (rate_limit_events — 검색 · 친구 요청 · 그룹 코드 실패)
--     · 깨우기 발송 기록 (push_sends)
--     · 푸시 영수증 (push_tickets — 영수증 배치가 15분 뒤 확인하고 24시간 뒤엔 포기하지만, 남은 줄이 없도록 마지막 안전망)
--     · 끝난 알람 제안 (alarm_proposals — 적용 · 무시 · 대체 · 만료된 지 7일이면서 알람 시각도 7일 넘게 지난 것, 또는 대기 중인데 알람 시각이 7일 넘게 지난 것.
--       알람이 아직 안 지난 적용 · 무시 줄은 보낸 친구의 '반영됨' · '제안함'(무시도 같은 라벨) 한 줄의 근거라 남김. 13장 표에는 없던 표라 같은 7일로 맞춤: 11/9 헤드 결정 '보관 기간은 개인정보 PR에서')
--   기상 기록(daily_records · alarm_events)은 계정이 있는 동안 남김
-- =====================================================================

-- 지운 줄 수를 표로 돌려줌 (시험 · 로그용). 앱 · 서버 함수는 못 부르고 DB 예약(pg_cron)만 부름
create function private.purge_old_friend_records()
returns table (rate_limit_deleted integer, push_sends_deleted integer, push_tickets_deleted integer, alarm_proposals_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limits    integer;
  v_sends     integer;
  v_tickets   integer;
  v_proposals integer;
begin
  with d as (delete from public.rate_limit_events where created_at < now() - interval '7 days' returning 1)
  select count(*)::integer into v_limits from d;

  with d as (delete from public.push_sends where sent_at < now() - interval '7 days' returning 1)
  select count(*)::integer into v_sends from d;

  with d as (delete from public.push_tickets where created_at < now() - interval '7 days' returning 1)
  select count(*)::integer into v_tickets from d;

  with d as (
    delete from public.alarm_proposals
    where (status <> 'PENDING' and coalesce(responded_at, created_at) < now() - interval '7 days'
           and greatest(from_at, to_at) < now() - interval '7 days')
       or (status = 'PENDING' and from_at < now() - interval '7 days')
    returning 1)
  select count(*)::integer into v_proposals from d;

  return query select v_limits, v_sends, v_tickets, v_proposals;
end;
$$;

revoke execute on function private.purge_old_friend_records() from public, anon, authenticated, service_role;

-- pg_cron이 있는 곳(실제 Supabase)에서만 예약 — 매일 UTC 18:00 = 한국 새벽 3시. 서버 함수 없이 SQL 한 줄, 같은 이름으로 다시 예약하면 갈아끼움
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('friend-records-purge', '0 18 * * *', $cmd$select private.purge_old_friend_records()$cmd$);
  end if;
end;
$$;
