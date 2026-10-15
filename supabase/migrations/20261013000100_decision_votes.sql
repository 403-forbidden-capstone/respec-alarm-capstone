-- 결정 안건 페이지(/decisions) 투표 · 정한 것 상태 — 회의 도구용 (decision_comments와 같은 예외 규칙)
--   decision_votes   안마다 이름당 1표 (질문이 여러 개인 안건은 block 1, 2 …로 질문마다 1표). 바꾸기 · 취소 가능
--   decision_states  페이지에서 정한 것 · 보류 · 다시 정할 것으로 옮긴 상태 + 코드 반영 라벨. 문서(docs/decisions.md) 상태보다 먼저 보임
--   한 안이 3표가 되면(질문 하나짜리 안건만) 자동으로 정한 것, 상태가 바뀔 때마다 의견 목록에 [정한 것] 같은 줄이 자동으로 남음
-- 링크를 아는 사람은 로그인 없이 읽고 씀(anon). 시각은 서버가 정함
-- 회의 동안만 쓰는 도구 — 실서비스 DB로 갈 때는 drop하는 마이그레이션을 넣고 supabase/tests의 MEETING 예외도 지움 (10/13 결정)
-- 여러 번 돌려도 같은 결과 — Actions가 막혀 SQL 편집기로 먼저 넣고, 나중에 워크플로가 다시 돌려도 됨

create table if not exists public.decision_votes (
  decision_id text not null check (decision_id ~ '^D[0-9]{1,3}$'),
  block       smallint not null default 0 check (block between 0 and 9),
  voter       text not null check (char_length(btrim(voter)) between 1 and 30),
  option_key  text not null check (option_key ~ '^[A-Z]$'),
  created_at  timestamptz not null default now(),
  primary key (decision_id, block, voter)
);

create table if not exists public.decision_states (
  decision_id text primary key check (decision_id ~ '^D[0-9]{1,3}$'),
  status      text not null check (status in ('정할 것', '보류', '정한 것')),
  choice      text check (choice is null or choice ~ '^[0-9A-Z ·]{1,20}$'),
  result      text not null default '' check (char_length(result) <= 500),
  via         text not null default '직접' check (via in ('직접', '투표', '문서')),  -- 문서 = docs/decisions.md에서 이미 정한 안건에 코드 라벨만 붙인 줄
  decided_by  text not null default '' check (char_length(decided_by) <= 120),
  decided_at  timestamptz,
  code_status text not null default '반영 전' check (code_status in ('반영 전', '반영 중', '반영됨', '코드 없음')),
  code_ref    text not null default '' check (char_length(code_ref) <= 40),
  updated_by  text not null default '' check (char_length(updated_by) <= 30),
  updated_at  timestamptz not null default now()
);

alter table public.decision_votes enable row level security;
alter table public.decision_states enable row level security;

drop policy if exists decision_votes_read on public.decision_votes;
create policy decision_votes_read on public.decision_votes for select to anon, authenticated using (true);
drop policy if exists decision_votes_write on public.decision_votes;
create policy decision_votes_write on public.decision_votes for insert to anon, authenticated with check (true);
drop policy if exists decision_votes_edit on public.decision_votes;
create policy decision_votes_edit on public.decision_votes for update to anon, authenticated using (true) with check (true);
drop policy if exists decision_votes_cancel on public.decision_votes;
create policy decision_votes_cancel on public.decision_votes for delete to anon, authenticated using (true);

drop policy if exists decision_states_read on public.decision_states;
create policy decision_states_read on public.decision_states for select to anon, authenticated using (true);
drop policy if exists decision_states_write on public.decision_states;
create policy decision_states_write on public.decision_states for insert to anon, authenticated with check (true);
drop policy if exists decision_states_edit on public.decision_states;
create policy decision_states_edit on public.decision_states for update to anon, authenticated using (true) with check (true);

-- 시각은 서버가: 쓸 수 있는 칸만 열어 둠
revoke all on public.decision_votes from anon, authenticated;
grant select, delete on public.decision_votes to anon, authenticated;
grant insert (decision_id, block, voter, option_key), update (decision_id, block, voter, option_key) on public.decision_votes to anon, authenticated;  -- upsert는 키 칸도 다시 씀
revoke all on public.decision_states from anon, authenticated;
grant select on public.decision_states to anon, authenticated;
grant insert (decision_id, status, choice, result, via, decided_by, code_status, code_ref, updated_by),
      update (decision_id, status, choice, result, via, decided_by, code_status, code_ref, updated_by)
  on public.decision_states to anon, authenticated;

-- 상태 시각 (BEFORE): 고친 시각 · 정한 시각
create or replace function public.decision_states_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  if new.status = '정한 것' then
    if tg_op = 'INSERT' or old.status is distinct from '정한 것' then new.decided_at := pg_catalog.now(); end if;
  else
    new.decided_at := null;
  end if;
  return new;
end;
$$;

-- 상태가 바뀌면 의견 목록에 한 줄 + 다시 정할 것이면 표를 비움 (AFTER)
create or replace function public.decision_states_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who  text := coalesce(nullif(new.updated_by, ''), nullif(new.decided_by, ''), '이름 없음');
  line text;
begin
  if tg_op = 'INSERT' and new.via = '문서' then
    -- 문서에서 이미 정한 안건에 코드 라벨만 붙임 → 상태 줄은 안 남기고 [코드]만
    insert into public.decision_comments (decision_id, author, body)
    values (new.decision_id, '자동', '[코드] ' || new.code_status || case when new.code_ref <> '' then ' · ' || new.code_ref else '' end || ' · ' || who);
  elsif tg_op = 'INSERT' or old.status is distinct from new.status or old.choice is distinct from new.choice then
    if new.status = '정한 것' then
      line := '[정한 것] ' || coalesce(new.choice || '안', '') ||
              case when new.via = '투표' then ' · 투표 (' || new.decided_by || ')' else ' · ' || who end ||
              case when new.result <> '' then ' — ' || new.result else '' end;
    elsif new.status = '보류' then
      line := '[보류] ' || who || case when new.result <> '' then ' — ' || new.result else '' end;
    else
      line := '[다시 정할 것] ' || who;
      delete from public.decision_votes where decision_id = new.decision_id;
    end if;
    insert into public.decision_comments (decision_id, author, body) values (new.decision_id, '자동', line);
  elsif old.code_status is distinct from new.code_status or old.code_ref is distinct from new.code_ref then
    insert into public.decision_comments (decision_id, author, body)
    values (new.decision_id, '자동', '[코드] ' || new.code_status || case when new.code_ref <> '' then ' · ' || new.code_ref else '' end || ' · ' || who);
  end if;
  return null;
end;
$$;

-- 질문 하나짜리 안건(block 0)에서 한 안이 3표가 되면 정한 것 (AFTER)
create or replace function public.decision_votes_tally()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n      int;
  voters text;
begin
  if new.block <> 0 then return null; end if;
  select count(*), string_agg(v.voter, ' · ' order by v.created_at, v.voter) into n, voters
    from public.decision_votes v
   where v.decision_id = new.decision_id and v.block = 0 and v.option_key = new.option_key;
  if n >= 3 then
    insert into public.decision_states (decision_id, status, choice, via, decided_by, updated_by)
    values (new.decision_id, '정한 것', new.option_key, '투표', left(voters, 120), '자동')
    on conflict (decision_id) do update
      set status = '정한 것', choice = excluded.choice, via = '투표', decided_by = excluded.decided_by, updated_by = '자동', result = ''
      where public.decision_states.status <> '정한 것';
  end if;
  return null;
end;
$$;

revoke execute on function public.decision_states_stamp() from public, anon, authenticated;
revoke execute on function public.decision_states_note() from public, anon, authenticated;
revoke execute on function public.decision_votes_tally() from public, anon, authenticated;

drop trigger if exists decision_states_stamp on public.decision_states;
create trigger decision_states_stamp before insert or update on public.decision_states
  for each row execute function public.decision_states_stamp();
drop trigger if exists decision_states_note on public.decision_states;
create trigger decision_states_note after insert or update on public.decision_states
  for each row execute function public.decision_states_note();
drop trigger if exists decision_votes_tally on public.decision_votes;
create trigger decision_votes_tally after insert or update on public.decision_votes
  for each row execute function public.decision_votes_tally();

-- 실시간: 표 · 상태가 바뀌면 링크를 연 사람 모두에게 바로 (Supabase에만 있는 publication)
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['decision_votes', 'decision_states'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
-- 표를 취소(delete)했을 때도 누구 표였는지 실시간으로 받게
alter table public.decision_votes replica identity full;
