-- =====================================================================
-- RLS · 권한 (상세설계서 4.6)
--   모든 테이블(16개)에 RLS를 켜고 authenticated 역할에만 정책을 줌. anon은 아무것도 못 함
--   공유 판정: 최종 권한 = 친구 권한 ∪ 그룹 권한 (한 행이라도 true면 허용, 4.6 "최종 권한의 계산")
--     · 친구 권한은 두 사람의 친구 관계가 ACCEPTED일 때만 인정함
--     · 그룹 권한은 두 사람 다 그 그룹에 JOINED일 때만 인정함
--     · 기상 조회 그룹 권한은 준 사람이 그 그룹에서 기상 공유에 동의(wake_share_opt_in)했을 때만 인정함
--   판정 함수는 API에 안 드러나는 private 스키마에 둠
--     SECURITY DEFINER라 정책 안에서 다른 테이블을 읽어도 정책끼리 서로 부르지 않음(재귀 없음)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 판정 함수 (private 스키마)
-- ---------------------------------------------------------------------

create schema if not exists private;
comment on schema private is '내부 판정 · 트리거 함수 — API로 노출하지 않음';

-- 호출자가 그룹에 참여 중(JOINED)인지 확인함
create function private.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = (select auth.uid())
      and gm.invite_status = 'JOINED'
  );
$$;

-- 호출자가 초대받았거나 참여 중인지 확인함 (초대받은 사람도 그룹 이름은 봐야 수락함)
create function private.is_group_invited_or_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = (select auth.uid())
      and gm.invite_status in ('INVITED', 'JOINED')
  );
$$;

-- 호출자가 그룹을 만든 사람인지 확인함
create function private.is_group_owner(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.groups g
    where g.group_id = p_group_id
      and g.owner_id = (select auth.uid())
  );
$$;

-- 호출자가 볼 수 있는 약속인지 확인함 (본인이 만든 약속 또는 참여 중인 그룹의 공동 약속)
create function private.can_access_appointment(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.appointments a
    where a.appointment_id = p_appointment_id
      and (a.creator_id = (select auth.uid())
           or (a.group_id is not null and exists (
                 select 1
                 from public.group_members gm
                 where gm.group_id = a.group_id
                   and gm.user_id = (select auth.uid())
                   and gm.invite_status = 'JOINED')))
  );
$$;

-- 권한 행의 출처가 아직 살아 있는지 확인함
--   FRIEND: 두 사람의 친구 관계(source_id = friend_id)가 ACCEPTED
--   GROUP : 두 사람 다 그 그룹(source_id = group_id)에 JOINED
create function private.is_valid_permission_source(
  p_owner_id    uuid,
  p_grantee_id  uuid,
  p_source_type public.permission_source,
  p_source_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_source_type
    when 'FRIEND' then exists (
      select 1
      from public.friends f
      where f.friend_id = p_source_id
        and f.status = 'ACCEPTED'
        and ((f.requester_id = p_owner_id and f.addressee_id = p_grantee_id)
          or (f.requester_id = p_grantee_id and f.addressee_id = p_owner_id))
    )
    when 'GROUP' then (
      select count(*) = 2
      from public.group_members gm
      where gm.group_id = p_source_id
        and gm.user_id in (p_owner_id, p_grantee_id)
        and gm.invite_status = 'JOINED'
    )
    else false
  end;
$$;

-- 호출자에게 권한을 준 사람 목록 — 친구 권한과 그룹 권한을 합쳐 판단함
--   p_kind: VIEW_ALARM(알람 조회) · EDIT_ALARM(알람 설정) · VIEW_WAKE(기상 상태 조회)
--   출처가 끝난 권한 행(친구 해제 · 그룹 나감)은 남아 있어도 무시함
--   기상 조회 그룹 권한은 준 사람이 그 그룹에서 기상 공유에 동의했을 때만 인정함
create function private.granted_owner_ids(p_kind text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.owner_id
  from public.sharing_permissions sp
  where sp.grantee_id = (select auth.uid())
    and case p_kind
          when 'VIEW_ALARM' then sp.can_view_alarm
          when 'EDIT_ALARM' then sp.can_edit_alarm
          when 'VIEW_WAKE'  then sp.can_view_wake
          else false
        end
    and private.is_valid_permission_source(sp.owner_id, sp.grantee_id, sp.source_type, sp.source_id)
    and (p_kind <> 'VIEW_WAKE'
         or sp.source_type = 'FRIEND'
         or exists (
              select 1
              from public.group_members gm
              where gm.group_id = sp.source_id
                and gm.user_id = sp.owner_id
                and gm.wake_share_opt_in));
$$;


-- ---------------------------------------------------------------------
-- 2. RLS를 받쳐 주는 트리거
-- ---------------------------------------------------------------------

-- 주인 · 연결 칼럼은 못 바꾸게 함
--   예) 알람 설정 권한을 받은 사람이 남의 알람을 자기 것으로 옮기기, 구성원 행의 group_id를 바꿔 남의 그룹에 들어가기,
--       두 그룹에 함께 있는 그룹원이 공동 약속을 다른 그룹으로 옮기기
--   트리거 인자로 막을 칼럼 이름을 받음
create function private.prevent_key_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
      raise exception '%.% 칼럼은 바꿀 수 없음', tg_table_name, v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

create trigger keep_keys before update on public.friends
  for each row execute function private.prevent_key_change('requester_id', 'addressee_id');
create trigger keep_keys before update on public.group_members
  for each row execute function private.prevent_key_change('group_id', 'user_id');
create trigger keep_keys before update on public.appointments
  for each row execute function private.prevent_key_change('creator_id', 'group_id');
create trigger keep_keys before update on public.alarms
  for each row execute function private.prevent_key_change('user_id', 'participant_id', 'routine_id');

-- 그룹을 만든 사람을 바로 구성원(JOINED)으로 넣음
create function private.add_group_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.group_members (group_id, user_id, invite_status, joined_at)
  values (new.group_id, new.owner_id, 'JOINED', now())
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;

create trigger add_owner_as_member after insert on public.groups
  for each row execute function private.add_group_owner_as_member();

-- 만든 사람이 다른 구성원을 내보내면(행 삭제) 초대 코드를 새로 바꿈
--   내보내진 사람은 코드를 이미 알고 있어서, 안 바꾸면 그 코드로 바로 다시 들어올 수 있음
--   본인이 나간 경우 · 탈퇴(auth 계정 삭제)로 지워진 경우는 그대로 둠. 그룹을 지울 때는 바꿀 행이 없어 넘어감
create function private.rotate_invite_code_on_kick()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.user_id is distinct from (select auth.uid()) then
    update public.groups g
    set invite_code = default
    where g.group_id = old.group_id
      and g.owner_id = (select auth.uid());
  end if;
  return null;
end;
$$;

create trigger rotate_invite_code_on_kick after delete on public.group_members
  for each row execute function private.rotate_invite_code_on_kick();

-- 관계가 끝나면 그 출처로 준 권한 행만 지움 (4.7 "권한 회수" — 다른 출처의 권한은 그대로 둠)
--   4.7은 애플리케이션 삭제지만, 상대가 준 권한 행은 RLS상 앱이 못 지우므로 DB에서 같은 규칙으로 처리함
create function private.revoke_friend_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.sharing_permissions sp
  where sp.source_type = 'FRIEND'
    and sp.source_id = old.friend_id;
  return null;
end;
$$;

create function private.revoke_group_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.sharing_permissions sp
  where sp.source_type = 'GROUP'
    and sp.source_id = old.group_id
    and old.user_id in (sp.owner_id, sp.grantee_id);
  return null;
end;
$$;

-- 친구 삭제 · 차단(ACCEPTED가 아니게 됨)
create trigger revoke_permissions_on_delete after delete on public.friends
  for each row execute function private.revoke_friend_permissions();
create trigger revoke_permissions_on_change after update of status on public.friends
  for each row when (old.status = 'ACCEPTED' and new.status <> 'ACCEPTED')
  execute function private.revoke_friend_permissions();

-- 그룹에서 나감 · 내보내짐 · 그룹 삭제(구성원 행이 CASCADE로 지워짐)
create trigger revoke_permissions_on_delete after delete on public.group_members
  for each row execute function private.revoke_group_permissions();
create trigger revoke_permissions_on_change after update of invite_status on public.group_members
  for each row when (old.invite_status = 'JOINED' and new.invite_status <> 'JOINED')
  execute function private.revoke_group_permissions();


-- ---------------------------------------------------------------------
-- 3. 친구 · 그룹원 공개 프로필 (4.6 "닉네임만 조회")
-- ---------------------------------------------------------------------
-- profiles RLS는 본인 행만 보여 줌 (집 위치 · 기본 준비시간 등을 남에게 안 보이게)
-- 관계 있는 사람(친구 · 친구 요청 · 같은 그룹)의 닉네임 · 사진 · 아이디는 이 함수로만 줌
-- p_user_ids를 주면 그중 관계 있는 사람만, 안 주면 관계 있는 사람 전부
create function public.get_public_profiles(p_user_ids uuid[] default null)
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid
  ),
  related as (
    select m.uid as user_id
    from me m
    where m.uid is not null
    union
    select case when f.requester_id = m.uid then f.addressee_id else f.requester_id end
    from public.friends f
    join me m on m.uid in (f.requester_id, f.addressee_id)
    where f.status <> 'BLOCKED'
    union
    select other.user_id
    from public.group_members mine
    join me m on m.uid = mine.user_id
    join public.group_members other on other.group_id = mine.group_id
    where mine.invite_status in ('INVITED', 'JOINED')
      and other.invite_status in ('INVITED', 'JOINED')
  )
  select p.user_id, p.nickname, p.profile_image_url, p.handle
  from public.profiles p
  join related r on r.user_id = p.user_id
  where p_user_ids is null or p.user_id = any (p_user_ids);
$$;


-- ---------------------------------------------------------------------
-- 4. RLS 켜기 — 16개 테이블 전부
-- ---------------------------------------------------------------------

alter table public.profiles                 enable row level security;
alter table public.friends                  enable row level security;
alter table public.groups                   enable row level security;
alter table public.group_members            enable row level security;
alter table public.sharing_permissions      enable row level security;
alter table public.appointments             enable row level security;
alter table public.appointment_participants enable row level security;
alter table public.alarms                   enable row level security;
alter table public.alarm_events             enable row level security;
alter table public.alarm_suggestions        enable row level security;
alter table public.routines                 enable row level security;
alter table public.conversation_sessions    enable row level security;
alter table public.todos                    enable row level security;
alter table public.daily_records            enable row level security;
alter table public.daily_journals           enable row level security;
alter table public.push_tokens              enable row level security;


-- ---------------------------------------------------------------------
-- 5. 정책 — 사용자 · 소셜
-- ---------------------------------------------------------------------

-- profiles: 본인만 조회 · 수정 (친구 · 그룹원은 get_public_profiles로 닉네임만)
--   행은 가입 트리거가 만들고, 탈퇴는 auth 계정 삭제로 처리하므로 DELETE 정책 없음
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- friends: 두 당사자만 봄
--   요청은 본인이 PENDING으로만 만들고, 수락 · 차단은 받은 사람만 함
--   삭제(요청 취소 · 친구 끊기)는 둘 다 되지만 차단당한 요청자는 차단을 못 지움
create policy friends_select_party on public.friends
  for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

create policy friends_insert_request on public.friends
  for insert to authenticated
  with check (requester_id = (select auth.uid())
              and status = 'PENDING'
              and accepted_at is null);

create policy friends_update_addressee on public.friends
  for update to authenticated
  using (addressee_id = (select auth.uid()))
  with check (addressee_id = (select auth.uid()));

create policy friends_delete_party on public.friends
  for delete to authenticated
  using (addressee_id = (select auth.uid())
         or (requester_id = (select auth.uid()) and status <> 'BLOCKED'));

-- groups: 만든 사람과 초대받은 · 참여 중인 사람이 봄. 수정 · 삭제는 만든 사람만
create policy groups_select_member on public.groups
  for select to authenticated
  using (owner_id = (select auth.uid()) or private.is_group_invited_or_member(group_id));

create policy groups_insert_owner on public.groups
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy groups_update_owner on public.groups
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy groups_delete_owner on public.groups
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- group_members: 본인 행과, 참여 중인 그룹의 구성원 목록을 봄
--   초대는 참여 중인 구성원 · 만든 사람이 INVITED로만 함 (기상 공유 동의는 꺼진 채로)
--   수락 · 기상 공유 동의 · 나가기는 본인만 함 (남이 내 동의를 켤 수 없음)
--   내보내기는 만든 사람이 행을 지워서 함 (그때 초대 코드가 새로 바뀜)
create policy group_members_select on public.group_members
  for select to authenticated
  using (user_id = (select auth.uid())
         or private.is_group_member(group_id)
         or private.is_group_owner(group_id));

create policy group_members_insert_invite on public.group_members
  for insert to authenticated
  with check (invite_status = 'INVITED'
              and wake_share_opt_in = false
              and joined_at is null
              and (private.is_group_member(group_id) or private.is_group_owner(group_id)));

create policy group_members_update_self on public.group_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_group_owner(group_id));

-- sharing_permissions: 준 사람 · 받은 사람이 봄 (화면에 출처별로 보여 줌)
--   주기 · 바꾸기 · 회수는 준 사람만. 출처(친구 관계 · 그룹)가 살아 있어야 만들 수 있음
create policy sharing_permissions_select_party on public.sharing_permissions
  for select to authenticated
  using ((select auth.uid()) in (owner_id, grantee_id));

create policy sharing_permissions_insert_owner on public.sharing_permissions
  for insert to authenticated
  with check (owner_id = (select auth.uid())
              and private.is_valid_permission_source(owner_id, grantee_id, source_type, source_id));

create policy sharing_permissions_update_owner on public.sharing_permissions
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid())
              and private.is_valid_permission_source(owner_id, grantee_id, source_type, source_id));

create policy sharing_permissions_delete_owner on public.sharing_permissions
  for delete to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 6. 정책 — 일정 · 알람
-- ---------------------------------------------------------------------

-- appointments: 개인 일정(group_id 없음)은 본인만
--   공동 약속은 참여 중인 그룹원도 조회 · 수정함. 삭제는 등록자만
--   등록자 · 그룹(creator_id · group_id)은 keep_keys 트리거가 못 바꾸게 함
create policy appointments_select on public.appointments
  for select to authenticated
  using (creator_id = (select auth.uid())
         or (group_id is not null and private.is_group_member(group_id)));

create policy appointments_insert on public.appointments
  for insert to authenticated
  with check (creator_id = (select auth.uid())
              and (group_id is null or private.is_group_member(group_id)));

create policy appointments_update on public.appointments
  for update to authenticated
  using (creator_id = (select auth.uid())
         or (group_id is not null and private.is_group_member(group_id)))
  with check ((group_id is null and creator_id = (select auth.uid()))
              or (group_id is not null and private.is_group_member(group_id)));

create policy appointments_delete_creator on public.appointments
  for delete to authenticated
  using (creator_id = (select auth.uid()));

-- appointment_participants: 본인 행만 (그룹원끼리도 남의 출발지 · 도착 결과는 못 봄)
--   볼 수 있는 약속에만 참여 조건을 만들 수 있음
create policy appointment_participants_select_own on public.appointment_participants
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy appointment_participants_insert_own on public.appointment_participants
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and private.can_access_appointment(appointment_id));

create policy appointment_participants_update_own on public.appointment_participants
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and private.can_access_appointment(appointment_id));

create policy appointment_participants_delete_own on public.appointment_participants
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- alarms: 4.6 정책 예시 ①②③ 구조를 따르고 공유 판정만 함수로 바꿈
-- ① 본인 알람은 항상 조회 가능
create policy alarms_select_own on public.alarms
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ② 친구 · 그룹에서 조회 권한을 받았으면 조회 가능 (여러 관계 중 하나라도 true면 허용)
create policy alarms_select_shared on public.alarms
  for select to authenticated
  using (user_id in (select private.granted_owner_ids('VIEW_ALARM')));

-- 만들기는 본인만. 연결한 참여 조건 · 루틴도 본인 것이어야 함
create policy alarms_insert_own on public.alarms
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and ((participant_id is not null and exists (
                      select 1
                      from public.appointment_participants ap
                      where ap.participant_id = alarms.participant_id
                        and ap.user_id = (select auth.uid())))
                   or (routine_id is not null and exists (
                      select 1
                      from public.routines r
                      where r.routine_id = alarms.routine_id
                        and r.user_id = (select auth.uid())))));

-- ③ 설정 권한이 있으면 수정 가능 (FR-2-5, FR-3-3). 주인 · 연결 칼럼은 keep_keys 트리거가 막음
create policy alarms_update_shared on public.alarms
  for update to authenticated
  using (user_id = (select auth.uid())
         or user_id in (select private.granted_owner_ids('EDIT_ALARM')))
  with check (user_id = (select auth.uid())
              or user_id in (select private.granted_owner_ids('EDIT_ALARM')));

create policy alarms_delete_own on public.alarms
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- alarm_events: 본인만 (그룹원 기상 현황은 get_group_wake_status로만 봄). 본인 알람에만 기록함
create policy alarm_events_select_own on public.alarm_events
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy alarm_events_insert_own on public.alarm_events
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (
                select 1
                from public.alarms a
                where a.alarm_id = alarm_events.alarm_id
                  and a.user_id = (select auth.uid())));

create policy alarm_events_update_own on public.alarm_events
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and exists (
                select 1
                from public.alarms a
                where a.alarm_id = alarm_events.alarm_id
                  and a.user_id = (select auth.uid())));

create policy alarm_events_delete_own on public.alarm_events
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- alarm_suggestions: 본인만. 대상 알람 · 근거 이벤트도 본인 것이어야 함
create policy alarm_suggestions_select_own on public.alarm_suggestions
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy alarm_suggestions_insert_own on public.alarm_suggestions
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (target_alarm_id is null or exists (
                     select 1 from public.alarms a
                     where a.alarm_id = alarm_suggestions.target_alarm_id
                       and a.user_id = (select auth.uid())))
              and (source_event_id is null or exists (
                     select 1 from public.alarm_events e
                     where e.event_id = alarm_suggestions.source_event_id
                       and e.user_id = (select auth.uid()))));

create policy alarm_suggestions_update_own on public.alarm_suggestions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (target_alarm_id is null or exists (
                     select 1 from public.alarms a
                     where a.alarm_id = alarm_suggestions.target_alarm_id
                       and a.user_id = (select auth.uid())))
              and (source_event_id is null or exists (
                     select 1 from public.alarm_events e
                     where e.event_id = alarm_suggestions.source_event_id
                       and e.user_id = (select auth.uid()))));

create policy alarm_suggestions_delete_own on public.alarm_suggestions
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 7. 정책 — 루틴 · AI 대화 · 기록 · 푸시 토큰 (전부 본인만)
-- ---------------------------------------------------------------------

-- routines: 근거 일기도 본인 것이어야 함
create policy routines_select_own on public.routines
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy routines_insert_own on public.routines
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (source_journal_id is null or exists (
                     select 1 from public.daily_journals j
                     where j.journal_id = routines.source_journal_id
                       and j.user_id = (select auth.uid()))));

create policy routines_update_own on public.routines
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (source_journal_id is null or exists (
                     select 1 from public.daily_journals j
                     where j.journal_id = routines.source_journal_id
                       and j.user_id = (select auth.uid()))));

create policy routines_delete_own on public.routines
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- conversation_sessions
create policy conversation_sessions_select_own on public.conversation_sessions
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy conversation_sessions_insert_own on public.conversation_sessions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy conversation_sessions_update_own on public.conversation_sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy conversation_sessions_delete_own on public.conversation_sessions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- todos: 4.6 표에 없어 본인만으로 둠. 연결 약속은 볼 수 있는 약속, 생성 대화는 본인 것이어야 함
create policy todos_select_own on public.todos
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy todos_insert_own on public.todos
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (appointment_id is null or private.can_access_appointment(appointment_id))
              and (source_session_id is null or exists (
                     select 1 from public.conversation_sessions s
                     where s.session_id = todos.source_session_id
                       and s.user_id = (select auth.uid()))));

create policy todos_update_own on public.todos
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (appointment_id is null or private.can_access_appointment(appointment_id))
              and (source_session_id is null or exists (
                     select 1 from public.conversation_sessions s
                     where s.session_id = todos.source_session_id
                       and s.user_id = (select auth.uid()))));

create policy todos_delete_own on public.todos
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- daily_records
create policy daily_records_select_own on public.daily_records
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy daily_records_insert_own on public.daily_records
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy daily_records_update_own on public.daily_records
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy daily_records_delete_own on public.daily_records
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- daily_journals: 근거 대화도 본인 것이어야 함
create policy daily_journals_select_own on public.daily_journals
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy daily_journals_insert_own on public.daily_journals
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (source_session_id is null or exists (
                     select 1 from public.conversation_sessions s
                     where s.session_id = daily_journals.source_session_id
                       and s.user_id = (select auth.uid()))));

create policy daily_journals_update_own on public.daily_journals
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and (source_session_id is null or exists (
                     select 1 from public.conversation_sessions s
                     where s.session_id = daily_journals.source_session_id
                       and s.user_id = (select auth.uid()))));

create policy daily_journals_delete_own on public.daily_journals
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- push_tokens: 본인만 (다른 계정에 남은 토큰 가져오기는 register_push_token)
create policy push_tokens_select_own on public.push_tokens
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy push_tokens_insert_own on public.push_tokens
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy push_tokens_update_own on public.push_tokens
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy push_tokens_delete_own on public.push_tokens
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 8. 권한(GRANT) — 기본값에 기대지 않고 직접 정함
-- ---------------------------------------------------------------------

-- 스키마
grant usage on schema public to authenticated, service_role;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- 테이블: anon은 막고, authenticated는 읽기 · 쓰기를 주되 행 범위는 RLS가 정함
revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
revoke insert, update, delete on public.v_prepare_time_stats from authenticated, service_role;

-- 시퀀스: alarm_events.event_id (bigserial)
revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- 함수: 기본으로 열린 실행 권한을 닫고, 앱이 부를 함수와 정책이 쓰는 판정 함수만 엶
--   트리거 함수는 실행 권한이 없어도 트리거로는 돌아감
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.find_profile_by_handle(text),
  public.join_group_by_invite_code(text),
  public.regenerate_invite_code(uuid),
  public.get_group_wake_status(uuid, date),
  public.register_push_token(text, text),
  public.get_public_profiles(uuid[])
to authenticated;

grant execute on function
  private.is_group_member(uuid),
  private.is_group_invited_or_member(uuid),
  private.is_group_owner(uuid),
  private.can_access_appointment(uuid),
  private.is_valid_permission_source(uuid, uuid, public.permission_source, uuid),
  private.granted_owner_ids(text)
to authenticated;

grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
