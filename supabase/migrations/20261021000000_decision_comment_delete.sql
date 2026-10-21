-- 결정 안건 페이지(/decisions) 의견 지우기 — 내 이름으로 남긴 의견만 (10/21 지형님 요청, #191)
--   지우면 숨김(deleted_at)만 하고 줄은 남김 — 잘못 지워도 SQL 편집기에서 deleted_at을 비우면 돌아옴
--   (숨긴 줄도 읽기 정책상 그대로 읽힘 — 좁히면 실시간 UPDATE가 anon에게 안 가서 남의 화면에서 안 빠짐. 문서로 옮길 땐 deleted_at is null만)
--   이름 확인은 투표와 같은 수준(로그인 없는 회의 도구) — 같은 이름을 적으면 지울 수 있음
--   상태가 바뀔 때 남는 '자동' 줄은 안 지움 (안건 기록) — 사람이 '자동' 이름으로 남기는 것도 막음(가짜 자동 줄)
--   테이블을 직접 고치거나 지우는 권한은 그대로 막고, 이 함수로만 지움
--   anon이 실행하는 함수는 이것 하나 — 회의 도구 예외(supabase/tests의 MEETING_FN)
--   실서비스 DB로 갈 때 회의 테이블을 drop하면 이 함수도 같이 drop하고 MEETING_FN도 지움 (본문은 테이블 의존으로 안 잡혀 함수만 남음)
-- 여러 번 돌려도 같은 결과

alter table public.decision_comments add column if not exists deleted_at timestamptz;

-- 사람은 '자동' 이름으로 못 남김 — 자동 줄은 트리거(security definer, 테이블 주인)만 넣음
drop policy if exists decision_comments_write on public.decision_comments;
create policy decision_comments_write on public.decision_comments for insert to anon, authenticated
  with check (pg_catalog.btrim(author) <> '자동');

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
     and pg_catalog.btrim(author) <> '자동'
     and deleted_at is null;
  return found;
end;
$$;

revoke execute on function public.delete_decision_comment(bigint, text) from public;
grant execute on function public.delete_decision_comment(bigint, text) to anon, authenticated;
