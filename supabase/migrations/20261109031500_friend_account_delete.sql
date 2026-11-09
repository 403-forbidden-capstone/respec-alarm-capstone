-- =====================================================================
-- 친구 12장 — 계정 삭제 (친구 논리설계 12장, 11/8 확정 + 11/9 헤드 결정). 이슈 #418
--   ① appointments.creator_id: 계정을 지울 때 연쇄로 지우던 것을 '비움'으로 — 내가 만든 공동 약속은 '만든 사람 알 수 없음'으로 남고 참여자 누구나 고침 (12-가 · 9-아)
--      개인 약속(그룹 없음)은 만든 사람이 늘 있어야 하므로 계정을 지우기 전에 prepare_account_delete가 먼저 지움 (L3 함정 5) — 준비 없이 지워도 프로필 삭제 직전에 트리거가 지움
--   ② 키 칸 보호(keep_keys)는 creator_id를 '비우는' 두 경우만 풀어 줌 — 그 사람의 프로필이 지워질 때(FK가 비움) · 그 사람이 그 그룹을 나간 뒤
--   ③ 그룹을 나갈 때 그 사람이 만든 앞으로 공동 약속의 만든 사람 칸을 비움 (11/9 헤드 결정, 9장 보정이 #406에 빠져 있었음)
--   ④ prepare_account_delete(서버 전용) — 계정을 지우기 전 준비: 개인 약속 삭제 · 모든 그룹에서 나가기 · 푸시 토큰 삭제. 몇 번 불러도 같음
--   ⑤ my_account_delete_summary — 설정 > [계정 삭제] 확인 문구용 영향 요약
-- 친구 · 권한 · 차단 · 알람 · 기록 · 프로필은 계정(auth.users)이 지워질 때 기존 연쇄로 같이 지워짐
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 만든 사람 칸: 연쇄 삭제 → 비움
-- ---------------------------------------------------------------------

alter table public.appointments drop constraint appointments_creator_id_fkey;
alter table public.appointments
  add constraint appointments_creator_id_fkey foreign key (creator_id) references public.profiles (user_id) on delete set null;

-- 개인 약속(그룹 없음)은 만든 사람이 없을 수 없음
alter table public.appointments
  add constraint appointments_creator_or_group check (creator_id is not null or group_id is not null);

comment on column public.appointments.creator_id is '만든 사람. 공동 약속은 만든 사람이 탈퇴하거나 그룹을 나가면 비어 ''알 수 없음''이 되고 참여자 누구나 고침. 개인 약속은 늘 있음';


-- ---------------------------------------------------------------------
-- 2. 키 칸 보호: creator_id는 '비움'만 두 경우에 허용
-- ---------------------------------------------------------------------

-- 20261007000200 · 20261029075743의 keep_keys(주인 · 연결 칼럼은 못 바꿈) 중 appointments만 이 함수로 바꿈. group_id · 반복 묶음 · 날짜(series_id · occurrence_on)는 그대로 못 바꿈.
--   creator_id는 값 → 비움 하나만: 그 사람의 프로필이 이미 없거나(계정 삭제의 FK가 비우는 때) 그 그룹의 참여 멤버가 아닐 때(나간 뒤).
--   참여 중인 사람이 자기 약속을 스스로 비우는 길은 여전히 막힘
create function private.prevent_appointment_key_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array array['group_id', 'series_id', 'occurrence_on'] loop
    if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
      raise exception 'appointments.% 칼럼은 바꿀 수 없음', v_col using errcode = '42501';
    end if;
  end loop;
  if new.creator_id is distinct from old.creator_id then
    if not (
      new.creator_id is null and old.creator_id is not null and old.group_id is not null
      and (not exists (select 1 from public.profiles p where p.user_id = old.creator_id)
           or not exists (select 1 from public.group_members gm
                          where gm.group_id = old.group_id and gm.user_id = old.creator_id and gm.invite_status = 'JOINED'))
    ) then
      raise exception 'appointments.creator_id 칼럼은 바꿀 수 없음' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger keep_keys on public.appointments;
create trigger keep_keys before update on public.appointments
  for each row execute function private.prevent_appointment_key_change();


-- 안전망: 계정(프로필)이 준비 없이 지워져도(시드 · 시험 도구가 계정만 지우는 경우) 개인 약속이 만든 사람 없이 남아 삭제가 막히지 않게 먼저 지움.
--   prepare_account_delete가 같은 일을 미리 해서 개수를 세어 줌. 공동 약속은 지우지 않고 FK가 만든 사람 칸만 비움
create function private.delete_personal_appointments_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.appointments where creator_id = old.user_id and group_id is null;
  return old;
end;
$$;

create trigger delete_personal_appointments before delete on public.profiles
  for each row execute function private.delete_personal_appointments_on_profile_delete();


-- ---------------------------------------------------------------------
-- 3. 그룹을 나갈 때: 앞으로 약속의 참여 · 알람 지움(9장) + 그 사람이 만든 앞으로 공동 약속의 만든 사람 칸 비움
-- ---------------------------------------------------------------------

-- 20261109011723의 같은 함수(지난 약속 = 그 사람 시간대 오늘 0시 이전)에서 달라진 곳은 만든 사람 칸을 비우는 update 하나뿐.
--   지난 약속의 만든 사람은 기록으로 남음(계정을 지울 때만 FK가 비움)
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
    and a.appointment_at >= private.day_start(old.user_id)
    and ap.user_id = old.user_id;

  update public.appointments a
  set creator_id = null
  where a.group_id = old.group_id
    and a.creator_id = old.user_id
    and a.appointment_at >= private.day_start(old.user_id);

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
-- 4. 영향 요약 · 탈퇴 준비
-- ---------------------------------------------------------------------

-- 나갈 그룹 수 · 그중 내가 마지막 참여 멤버라 사라질 그룹 수 · 내가 만들어 남을 공동 약속 수(사라질 그룹의 약속은 같이 사라지므로 뺌) · 친구 수
create function private.account_delete_impact(p_user uuid)
returns table (groups_leaving integer, groups_disappearing integer, group_appointments_staying integer, friends integer)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select gm.group_id,
           not exists (
             select 1 from public.group_members o
             where o.group_id = gm.group_id and o.user_id <> p_user and o.invite_status = 'JOINED') as disappears
    from public.group_members gm
    where gm.user_id = p_user and gm.invite_status = 'JOINED')
  select (select count(*)::integer from mine),
         (select count(*)::integer from mine where disappears),
         (select count(*)::integer from public.appointments a join mine m on m.group_id = a.group_id
          where a.creator_id = p_user and not m.disappears),
         (select count(*)::integer from public.friends f
          where f.status = 'ACCEPTED' and p_user in (f.requester_id, f.addressee_id));
$$;

create function public.my_account_delete_summary()
returns table (groups_leaving integer, groups_disappearing integer, group_appointments_staying integer, friends integer)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.account_delete_impact((select auth.uid()));
$$;

-- 계정(auth.users)을 지우기 전에 account-delete 서버 함수가 부름. 순서가 중요함:
--   ① 개인 약속 먼저 삭제(만든 사람 없이 남을 수 없음 + 참여 · 알람 · 기록이 같이 지워짐)
--   ② 영향 요약을 먼저 세어 둠(나가고 나면 셀 수 없음)
--   ③ 푸시 토큰 삭제(이 뒤로 이 사람에게 푸시가 안 감)
--   ④ 모든 그룹에서 나가기(멤버 행 삭제 → after_group_member_gone: 앞으로 약속의 참여 · 알람 정리, 만든 사람 칸 비움, 마지막 참여 멤버였으면 그룹 삭제 — 초대만 받은 사람의 초대도 같이)
-- 공동 약속은 지우지 않음. 친구 · 권한 · 차단 · 알람 · 기록 · 프로필은 계정이 지워질 때 연쇄로 지워짐.
-- 같은 사람을 동시에 두 번 불러도 한 번씩 차례로 처리하고, 이미 끝났으면 모두 0 (다시 하기 안전)
create function public.prepare_account_delete(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_personal integer := 0;
  v_impact   record;
begin
  if p_user_id is null then
    return jsonb_build_object('groups_left', 0, 'groups_deleted', 0, 'personal_deleted', 0, 'group_appointments_kept', 0);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account_delete:' || p_user_id::text, 0));

  with d as (delete from public.appointments where creator_id = p_user_id and group_id is null returning 1)
  select count(*)::integer into v_personal from d;

  select * into v_impact from private.account_delete_impact(p_user_id);

  delete from public.push_tokens where user_id = p_user_id;
  delete from public.group_members where user_id = p_user_id;

  return jsonb_build_object(
    'groups_left', v_impact.groups_leaving,
    'groups_deleted', v_impact.groups_disappearing,
    'personal_deleted', v_personal,
    'group_appointments_kept', v_impact.group_appointments_staying);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function private.prevent_appointment_key_change() from public, anon, authenticated;
revoke execute on function private.delete_personal_appointments_on_profile_delete() from public, anon, authenticated;
revoke execute on function private.account_delete_impact(uuid) from public, anon, authenticated;
revoke execute on function public.prepare_account_delete(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_delete(uuid) to service_role;
revoke execute on function public.my_account_delete_summary() from public, anon;
grant execute on function public.my_account_delete_summary() to authenticated;
