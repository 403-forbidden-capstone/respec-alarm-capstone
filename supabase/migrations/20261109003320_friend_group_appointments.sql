-- 친구 9장 — 공동 약속 DB 규칙 (친구_논리설계.md 9장, 시험케이스 9장 DB 층, 11/9 헤드 결정). 이슈 #404
--   ① 만든 사람 칸(creator_id)을 비울 수 있게: 탈퇴한 사람의 공동 약속은 '만든 사람 알 수 없음'으로 남고 참여자가 고침 (9-아 · 9-카, 비우는 일은 12장 탈퇴 연쇄)
--   ② 공동 약속 고치기는 만든 사람만(만든 사람이 비면 그 약속의 참여자 누구나), 앞으로 약속만, 그룹을 나간 사람은 더 못 고치고 못 지움 (9-자 · 9-d5 · 9-러)
--   ③ 지난 공동 약속에는 참여 조건을 새로 못 만듦 (개인 일정은 지나도 기록하러 만들 수 있음) (9-러)
--   ④ 그룹을 나가거나 내보내지면 그 그룹의 '앞으로' 약속의 참여 · 알람만 지움 — 지난 약속의 참여 · 울림 · 이동 시간 기록은 남음 (11/9 결정, 5장 트리거 고침)
--   ⑤ 인원수 · 참여자 조회: 참여 = 그 약속에 알람이 하나라도 켜져 있음 (9-타 · 9-마)
-- 판정 함수는 security definer + search_path 비움, 앱 역할 실행 권한은 아래 맨 끝에서 정리

-- ---------------------------------------------------------------------
-- 1. 만든 사람 칸 비우기 허용
-- ---------------------------------------------------------------------

alter table public.appointments alter column creator_id drop not null;


-- ---------------------------------------------------------------------
-- 2. 판정 도우미
-- ---------------------------------------------------------------------

-- 내가 이 약속에 참여 조건을 가졌나 (만든 사람이 비어 있는 약속을 고칠 자격)
create function private.is_appointment_participant(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointment_participants pt
    where pt.appointment_id = p_appointment_id and pt.user_id = (select auth.uid()));
$$;

-- 이 약속에 참여 조건을 새로 만들 수 있는 때인가: 개인 일정이거나, 공동 약속이면 아직 안 지났을 때
create function private.appointment_open_for_join(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
    where a.appointment_id = p_appointment_id
      and (a.group_id is null or a.appointment_at > now()));
$$;


-- ---------------------------------------------------------------------
-- 3. 정책
-- ---------------------------------------------------------------------

-- 개인 일정은 본인만. 공동 약속은 그 그룹에 참여 중이고 아직 안 지난 약속에서 만든 사람만(비었으면 참여자 누구나)
--   새 시각도 앞으로여야 함 — 지난 시각으로 옮겨 놓는 길을 닫음
drop policy appointments_update on public.appointments;
create policy appointments_update on public.appointments
  for update to authenticated
  using (
    (group_id is null and creator_id = (select auth.uid()))
    or (group_id is not null
        and appointment_at > now()
        and private.is_group_member(group_id)
        and (creator_id = (select auth.uid())
             or (creator_id is null and private.is_appointment_participant(appointment_id)))))
  with check (
    (group_id is null and creator_id = (select auth.uid()))
    or (group_id is not null
        and appointment_at > now()
        and private.is_group_member(group_id)
        and (creator_id = (select auth.uid())
             or (creator_id is null and private.is_appointment_participant(appointment_id)))));

-- 지우기는 만든 사람만 — 그룹을 나간 만든 사람은 남은 그룹원의 약속을 더 못 지움
drop policy appointments_delete_creator on public.appointments;
create policy appointments_delete_creator on public.appointments
  for delete to authenticated
  using (creator_id = (select auth.uid())
         and (group_id is null or private.is_group_member(group_id)));

-- 참여 조건 만들기: 볼 수 있는 약속 + 지난 공동 약속이 아님 (고치기는 도착 기록 때문에 막지 않음)
drop policy appointment_participants_insert_own on public.appointment_participants;
create policy appointment_participants_insert_own on public.appointment_participants
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and private.can_access_appointment(appointment_id)
              and private.appointment_open_for_join(appointment_id));


-- ---------------------------------------------------------------------
-- 4. 그룹을 나갈 때: 앞으로 약속의 참여 · 알람만 지움
-- ---------------------------------------------------------------------

-- 5장 함수(20261108183700)와 같고 달라진 곳은 지우는 약속이 '아직 안 지난 것'으로 좁혀진 한 줄뿐.
--   지난 약속의 참여 조건 · 알람 · 울림 기록 · 도착 기록은 그대로 남음 (알람은 참여 조건에 딸려 있어 같이 남음)
create or replace function private.after_group_member_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.appointment_participants ap
  using public.appointments a
  where ap.appointment_id = a.appointment_id
    and a.group_id = old.group_id
    and a.appointment_at > now()
    and ap.user_id = old.user_id;

  perform 1 from public.groups g where g.group_id = old.group_id for update;
  if found and not exists (
    select 1 from public.group_members gm where gm.group_id = old.group_id and gm.invite_status = 'JOINED'
  ) then
    delete from public.groups g where g.group_id = old.group_id;
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 인원수 · 참여자 조회
-- ---------------------------------------------------------------------

-- 그 그룹 약속마다 참여 수(그 그룹에 아직 참여 중인 사람 중 이 약속에 알람이 켜진 사람)와 내가 참여 중인지.
-- 참여 조건은 본인 줄만 읽히므로 서버가 세어 줌. 그룹에 참여 중인 사람만 부를 수 있고 아니면 빈 결과
create function public.group_appointment_counts(p_group_id uuid)
returns table (
  appointment_id uuid,
  joined_count   integer,
  i_joined       boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.appointment_id,
         (select count(*)::integer
          from public.appointment_participants pt
          join public.group_members gm on gm.group_id = a.group_id and gm.user_id = pt.user_id and gm.invite_status = 'JOINED'
          where pt.appointment_id = a.appointment_id
            and exists (select 1 from public.alarms al where al.participant_id = pt.participant_id and al.is_enabled)),
         exists (select 1
                 from public.appointment_participants pt
                 where pt.appointment_id = a.appointment_id and pt.user_id = (select auth.uid())
                   and exists (select 1 from public.alarms al where al.participant_id = pt.participant_id and al.is_enabled))
  from public.appointments a
  where a.group_id = p_group_id
    and private.is_group_member(p_group_id)
  order by a.appointment_at, a.appointment_id;
$$;

-- 그 약속의 그룹에 참여 중인 사람마다 참여(알람 켜짐) / 알람 없음 두 가지 — 안 누름 · 빠짐 · 끔은 모두 알람 없음.
-- 차단 쌍은 줄은 있되 참여 여부를 비워 둠(이름만 보임, 9-33). 그룹에 참여 중인 사람만 부를 수 있고 아니면 빈 결과
create function public.appointment_joiners(p_appointment_id uuid)
returns table (
  user_id uuid,
  joined  boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select gm.user_id,
         case
           when gm.user_id <> (select auth.uid()) and private.is_blocked_pair((select auth.uid()), gm.user_id) then null
           else exists (select 1
                        from public.appointment_participants pt
                        where pt.appointment_id = a.appointment_id and pt.user_id = gm.user_id
                          and exists (select 1 from public.alarms al where al.participant_id = pt.participant_id and al.is_enabled))
         end
  from public.appointments a
  join public.group_members gm on gm.group_id = a.group_id and gm.invite_status = 'JOINED'
  where a.appointment_id = p_appointment_id
    and a.group_id is not null
    and private.is_group_member(a.group_id)
  order by (gm.user_id = (select auth.uid())) desc, gm.user_id;
$$;


-- ---------------------------------------------------------------------
-- 6. 실행 권한
-- ---------------------------------------------------------------------

-- 정책이 부르는 판정 함수는 앱 역할이 실행할 수 있어야 함(5장 is_group_member와 같음)
revoke execute on function private.is_appointment_participant(uuid) from public, anon;
revoke execute on function private.appointment_open_for_join(uuid) from public, anon;
grant execute on function private.is_appointment_participant(uuid) to authenticated, service_role;
grant execute on function private.appointment_open_for_join(uuid) to authenticated, service_role;
revoke execute on function public.group_appointment_counts(uuid) from public, anon;
revoke execute on function public.appointment_joiners(uuid) from public, anon;
grant execute on function public.group_appointment_counts(uuid) to authenticated, service_role;
grant execute on function public.appointment_joiners(uuid) to authenticated, service_role;
