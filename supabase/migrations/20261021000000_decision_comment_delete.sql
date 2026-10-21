-- 결정 안건 페이지(/decisions) 의견 지우기 — 내 이름으로 남긴 의견만 (10/21 지형님 요청, #191)
--   지우면 숨김(deleted_at)만 하고 줄은 남김 — 잘못 지워도 SQL 편집기에서 deleted_at을 비우면 돌아옴
--   이름 확인은 투표와 같은 수준(로그인 없는 회의 도구) — 같은 이름을 적으면 지울 수 있음
--   상태가 바뀔 때 남는 '자동' 줄은 안 지움 (안건 기록)
--   테이블을 직접 고치거나 지우는 권한은 그대로 막고, 이 함수로만 지움
--   anon이 실행하는 함수는 이것 하나 — 회의 도구 예외(supabase/tests의 MEETING_FN)
-- 여러 번 돌려도 같은 결과

alter table public.decision_comments add column if not exists deleted_at timestamptz;

create or replace function public.delete_decision_comment(p_id bigint, p_author text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.decision_comments
     set deleted_at = pg_catalog.now()
   where id = p_id
     and pg_catalog.btrim(author) = pg_catalog.btrim(p_author)
     and author <> '자동'
     and deleted_at is null;
  return found;
end;
$$;

revoke execute on function public.delete_decision_comment(bigint, text) from public;
grant execute on function public.delete_decision_comment(bigint, text) to anon, authenticated;
