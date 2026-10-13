-- 결정 안건 페이지(/decisions) 회의 기록 — 앱 데이터와 따로 노는 회의 도구용 테이블 2개
--   decision_notes    안건마다 한 줄(D1 … · _meeting = 회의 공통 메모). 링크를 아는 사람은 로그인 없이 읽고 씀(anon)
--   decision_note_log 고칠 때마다 한 줄씩 쌓이는 기록 — 지워지거나 덮어써도 되살릴 수 있게. 화면에서는 못 읽음
-- 앱 테이블은 anon 권한이 없다는 규칙(supabase/tests)의 예외는 이 두 테이블뿐
-- 회의 동안만 쓰는 도구 — 실서비스 DB로 갈 때는 두 테이블 · 함수를 drop하는 마이그레이션을 넣고 supabase/tests의 MEETING 예외도 지움 (10/13 결정)
-- 여러 번 돌려도 같은 결과(if not exists · drop … if exists) — Actions가 막혀 SQL 편집기로 먼저 넣고, 나중에 워크플로가 다시 돌려도 됨

create table if not exists public.decision_notes (
  decision_id text primary key check (decision_id ~ '^(D[0-9]{1,3}|_meeting)$'),
  body        text not null default '' check (char_length(body) <= 8000),
  updated_by  text not null default '' check (char_length(updated_by) <= 30),
  updated_at  timestamptz not null default now()
);

create table if not exists public.decision_note_log (
  id          bigint generated always as identity primary key,
  decision_id text not null,
  body        text not null,
  updated_by  text not null,
  at          timestamptz not null default now()
);

alter table public.decision_notes enable row level security;
alter table public.decision_note_log enable row level security;

drop policy if exists decision_notes_read on public.decision_notes;
create policy decision_notes_read on public.decision_notes for select to anon, authenticated using (true);
drop policy if exists decision_notes_write on public.decision_notes;
create policy decision_notes_write on public.decision_notes for insert to anon, authenticated with check (true);
drop policy if exists decision_notes_edit on public.decision_notes;
create policy decision_notes_edit on public.decision_notes for update to anon, authenticated using (true) with check (true);

revoke all on public.decision_notes from anon, authenticated;
grant select, insert, update on public.decision_notes to anon, authenticated;
revoke all on public.decision_note_log from anon, authenticated;

-- 고친 시각은 서버 시각(BEFORE), 실제로 쓰인 뒤 기록 한 줄(AFTER) — upsert가 충돌로 UPDATE가 돼도 한 줄만
create or replace function public.decision_notes_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_when = 'BEFORE' then
    new.updated_at := pg_catalog.now();
    return new;
  end if;
  insert into public.decision_note_log (decision_id, body, updated_by) values (new.decision_id, new.body, new.updated_by);
  return null;
end;
$$;
revoke execute on function public.decision_notes_touch() from public, anon, authenticated;

drop trigger if exists decision_notes_touch on public.decision_notes;
create trigger decision_notes_touch before insert or update on public.decision_notes
  for each row execute function public.decision_notes_touch();
drop trigger if exists decision_notes_log on public.decision_notes;
create trigger decision_notes_log after insert or update on public.decision_notes
  for each row execute function public.decision_notes_touch();

-- 실시간: 다른 사람이 적으면 바로 보이게 (Supabase에만 있는 publication)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'decision_notes') then
    alter publication supabase_realtime add table public.decision_notes;
  end if;
end;
$$;
