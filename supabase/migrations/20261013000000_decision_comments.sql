-- 결정 안건 페이지(/decisions) 의견 — 앱 데이터와 따로 노는 회의 도구용 테이블
--   안건마다 여러 사람이 의견을 남김(이름 · 시각). 링크를 아는 사람은 로그인 없이 읽고 남김(anon)
--   남기기만 됨 — 고치기 · 지우기 X, 시각 · 번호는 서버가 정함
-- 앱 테이블은 anon 권한이 없다는 규칙(supabase/tests)의 예외는 이 테이블뿐
-- 회의 동안만 쓰는 도구 — 실서비스 DB로 갈 때는 drop하는 마이그레이션을 넣고 supabase/tests의 MEETING 예외도 지움 (10/13 결정)
-- 여러 번 돌려도 같은 결과 — Actions가 막혀 SQL 편집기로 먼저 넣고, 나중에 워크플로가 다시 돌려도 됨

-- 10/13 잠깐 SQL 편집기로만 넣었던 한 칸 기록 방식(decision_notes)은 의견 목록으로 바꿈
drop table if exists public.decision_notes;
drop table if exists public.decision_note_log;
drop function if exists public.decision_notes_touch();

create table if not exists public.decision_comments (
  id          bigint generated always as identity primary key,
  decision_id text not null check (decision_id ~ '^(D[0-9]{1,3}|_meeting)$'),
  author      text not null check (char_length(btrim(author)) between 1 and 30),
  body        text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index if not exists decision_comments_by_decision on public.decision_comments (decision_id, created_at);

alter table public.decision_comments enable row level security;

drop policy if exists decision_comments_read on public.decision_comments;
create policy decision_comments_read on public.decision_comments for select to anon, authenticated using (true);
drop policy if exists decision_comments_write on public.decision_comments;
create policy decision_comments_write on public.decision_comments for insert to anon, authenticated with check (true);

-- 남길 때 쓸 수 있는 칸은 안건 번호 · 이름 · 내용뿐 (번호 · 시각은 서버 기본값)
revoke all on public.decision_comments from anon, authenticated;
grant select on public.decision_comments to anon, authenticated;
grant insert (decision_id, author, body) on public.decision_comments to anon, authenticated;

-- 실시간: 누가 남기면 링크를 연 사람 모두에게 바로 보이게 (Supabase에만 있는 publication)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'decision_comments') then
    alter publication supabase_realtime add table public.decision_comments;
  end if;
end;
$$;
