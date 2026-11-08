-- =====================================================================
-- 친구 6장 — 공유 권한 (친구 논리설계 6장, 11/8 확정)
--   ① '설정이면 조회': 설정만 켠 행은 못 들어가고 조회를 끄면 설정도 같이 꺼짐, 친구 출처 기상 조회는 안 받음, 옛 행 정리 (6-라 · 6-가 · 6-차)
--   ② 그룹 권한 저장 DB 함수: 멤버 전원 한 트랜잭션 · 값이 그대로여도 저장 · 차단 쌍은 조용히 건너뜀, 권한을 준 뒤 들어온 멤버는 조회 행만 자동으로 (6-다 · 6-자 · 6-사)
--   ③ 알람 조회는 '일정에 붙은 알람'만 — 개인 일정 포함, 루틴 · 단독 알람 제외 (6-마 · 6-너)
--   ④ 기상 보기는 그룹 동의 하나로(권한 행 없이, 그룹마다 따로, 차단이면 안 보임) (6-가 · D19 · Q13)
--   ⑤ 알림 판정(can_send_push ALARM_CHANGED)은 설정 집합을 그대로 쓰는데, 설정 집합이 조회도 함께 가진 행만 담게 되어 설정과 조회를 둘 다 봄 (6-06)
-- 사람별 기상 숨기기는 7장, 알람 변경 요청 함수(권한 재확인 · '권한 없음')는 10장
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 옛 행 정리 — 제약을 걸기 전에
-- ---------------------------------------------------------------------

-- 친구 출처 기상 조회는 없앰(F03 친구 스위치 3개 → 2개)
update public.sharing_permissions set can_view_wake = false where source_type = 'FRIEND' and can_view_wake;

-- 그룹 권한은 (주인, 그룹) 한 벌: 멤버마다 값이 다르거나 일부 멤버에게 행이 없으면 꺼짐(좁은 쪽). 설정은 조회가 있을 때만 (6-16)
with g as (
  select sp.owner_id, sp.source_id as group_id, bool_and(sp.can_view_alarm) as v, bool_and(sp.can_edit_alarm) as e, count(*) as n
  from public.sharing_permissions sp
  where sp.source_type = 'GROUP'
  group by sp.owner_id, sp.source_id
), c as (
  select g.*, (select count(*) from public.group_members gm
               where gm.group_id = g.group_id and gm.invite_status = 'JOINED' and gm.user_id <> g.owner_id) as members
  from g
)
update public.sharing_permissions sp
set can_view_alarm = (c.v and c.n >= c.members),
    can_edit_alarm = (c.e and c.v and c.n >= c.members)
from c
where sp.source_type = 'GROUP' and sp.owner_id = c.owner_id and sp.source_id = c.group_id
  and (sp.can_view_alarm, sp.can_edit_alarm) is distinct from ((c.v and c.n >= c.members), (c.e and c.v and c.n >= c.members));

-- 친구 출처의 옛 '설정만' 행
update public.sharing_permissions set can_edit_alarm = false where can_edit_alarm and not can_view_alarm;


-- ---------------------------------------------------------------------
-- 2. 제약 · 트리거 — 설정이면 조회, 친구 출처 기상 조회 안 받음
-- ---------------------------------------------------------------------

alter table public.sharing_permissions
  add constraint sharing_permissions_edit_needs_view check (not can_edit_alarm or can_view_alarm);

-- 조회만 끄면 설정도 같이 꺼짐(제약에 걸리지 않게), 설정을 켜면서 조회를 끄는 건 제약이 막음 (6-04 · 6-05).
-- 친구 출처에 기상 조회를 써 넣어도 꺼진 채로 저장(예전 앱이 보내는 값을 거절하지 않고 무시) (6-가)
create function private.normalize_sharing_permission()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.can_edit_alarm and new.can_edit_alarm and old.can_view_alarm and not new.can_view_alarm then
    new.can_edit_alarm := false;
  end if;
  if new.source_type = 'FRIEND' then
    new.can_view_wake := false;
  end if;
  return new;
end;
$$;

create trigger normalize_sharing_permission
  before insert or update on public.sharing_permissions
  for each row execute function private.normalize_sharing_permission();


-- ---------------------------------------------------------------------
-- 3. 권한 집계 — 기상은 그룹 동의로만
-- ---------------------------------------------------------------------

-- 알람 조회 · 설정은 권한 행(친구 ∪ 그룹)에서, 설정은 조회를 함께 가진 같은 행만 인정(6-05 · 6-06). 출처가 끝난 행(친구 해제 · 그룹 나감 · 차단)은 무시.
-- 기상은 더 이상 권한 행으로 판정하지 않음 — '이 그룹에서 그 사람이 기상 공유에 동의했는가'를 get_group_wake_status가 그룹마다 직접 봄.
--   (집합 하나로 합치면 한 그룹의 동의가 다른 그룹 화면에 새기 때문. VIEW_WAKE는 빈 집합)
create or replace function private.granted_owner_ids_for(p_grantee_id uuid, p_kind text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.owner_id
  from public.sharing_permissions sp
  where sp.grantee_id = p_grantee_id
    and case p_kind
          when 'VIEW_ALARM' then sp.can_view_alarm
          when 'EDIT_ALARM' then sp.can_view_alarm and sp.can_edit_alarm
          else false
        end
    and private.is_valid_permission_source(sp.owner_id, sp.grantee_id, sp.source_type, sp.source_id);
$$;

-- 알람 조회는 일정에 붙은 알람만 (개인 일정 포함). 루틴 · 단독 알람은 권한이 있어도 안 보임 (6-39)
--   수정 정책(alarms_update_shared)은 그대로 — UPDATE는 조회 정책도 함께 통과해야 해서, 안 보이는 알람은 설정 권한이 있어도 못 고침
drop policy alarms_select_shared on public.alarms;
create policy alarms_select_shared on public.alarms
  for select to authenticated
  using (participant_id is not null and user_id in (select private.granted_owner_ids('VIEW_ALARM')));


-- ---------------------------------------------------------------------
-- 4. 그룹 권한 저장 · 참여 때 조회 행 자동
-- ---------------------------------------------------------------------

-- F03 그룹 관계 [변경사항 저장] — 참여 중 멤버 전원(나 빼고)에게 같은 값으로 한 번에. 함수 하나가 한 트랜잭션이라 전부 되거나 전부 안 됨 (6-17)
--   설정을 켜면 조회도 켜짐. 값이 그대로여도 update가 실행되어 수정 시각이 새로 찍힘(set_updated_at 트리거) —
--   권한을 준 뒤 들어온 멤버에게 설정을 주려면 다시 저장해야 하므로 (6-15)
--   차단 쌍은 오류 없이 건너뜀 — 행만 안 쓰고 응답(saved)은 건너뛴 사람도 센 값이라 결과 모양이 같아 차단이 드러나지 않음(4-가).
--   기상은 여기가 아니라 그룹 기상 공유 동의로만 (D19)
--   상태: OK(saved = 참여 중인 다른 멤버 수) · NO_MEMBERS(혼자인 그룹 — 앱은 오류로 보임, 가짜 성공 없음) · NOT_FOUND(참여 중 멤버가 아님)
create function public.save_group_permissions(p_group_id uuid, p_can_view_alarm boolean, p_can_edit_alarm boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_edit boolean;
  v_view boolean;
  v_n    integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_group_id is null or not exists (
    select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invite_status = 'JOINED'
  ) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  v_edit := coalesce(p_can_edit_alarm, false);
  v_view := coalesce(p_can_view_alarm, false) or v_edit;

  perform private.lock_group(p_group_id);
  select count(*) into v_n
  from public.group_members gm
  where gm.group_id = p_group_id and gm.invite_status = 'JOINED' and gm.user_id <> v_uid;
  if v_n = 0 then
    return jsonb_build_object('status', 'NO_MEMBERS');
  end if;

  insert into public.sharing_permissions as sp (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
  select v_uid, gm.user_id, 'GROUP'::public.permission_source, p_group_id, v_view, v_edit
  from public.group_members gm
  where gm.group_id = p_group_id and gm.invite_status = 'JOINED' and gm.user_id <> v_uid
    and not private.is_blocked_pair(v_uid, gm.user_id)
  on conflict (owner_id, grantee_id, source_type, source_id) do update
    set can_view_alarm = excluded.can_view_alarm, can_edit_alarm = excluded.can_edit_alarm;
  return jsonb_build_object('status', 'OK', 'saved', v_n);
end;
$$;

-- 참여 중이 된 사람(코드 참여 · 초대 수락 · 그룹 만들기)에게, 이미 그 그룹에 알람 조회를 준 멤버들의 조회 행만 자동으로 만듦.
-- 설정은 준 사람이 다시 저장해야 함 (6-사 · 6-14, 버그 b 고침)
create function private.grant_default_group_view()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.sharing_permissions (owner_id, grantee_id, source_type, source_id, can_view_alarm, can_edit_alarm)
  select distinct sp.owner_id, new.user_id, 'GROUP'::public.permission_source, new.group_id, true, false
  from public.sharing_permissions sp
  join public.group_members gm on gm.group_id = new.group_id and gm.user_id = sp.owner_id and gm.invite_status = 'JOINED'
  where sp.source_type = 'GROUP' and sp.source_id = new.group_id and sp.can_view_alarm
    and sp.owner_id <> new.user_id
    and not private.is_blocked_pair(sp.owner_id, new.user_id)
  on conflict (owner_id, grantee_id, source_type, source_id) do nothing;
  return null;
end;
$$;

create trigger grant_default_group_view_on_insert
  after insert on public.group_members
  for each row when (new.invite_status = 'JOINED')
  execute function private.grant_default_group_view();

create trigger grant_default_group_view_on_join
  after update of invite_status on public.group_members
  for each row when (old.invite_status is distinct from 'JOINED' and new.invite_status = 'JOINED')
  execute function private.grant_default_group_view();


-- ---------------------------------------------------------------------
-- 5. 그룹 기상 상태 — 보이는 사람 = 나 + 이 그룹에서 기상 공유에 동의한 참여 중 멤버 (차단 제외)
-- ---------------------------------------------------------------------

-- 지난 정의(group_wake ⑤)와 같고, 보이는 사람 판정만 바뀜: 권한 행(can_view_wake) 대신 '이 그룹에서 기상 공유에 동의한 참여 중 멤버'.
--   동의는 그룹마다 따로라 두 그룹에 같이 있어도 동의한 그룹의 화면에서만 보임(6-45). 동의를 끄면 바로 사라짐(6-24). 차단 쌍은 안 보임(4장).
--   사람별로 숨기기는 7장
create or replace function public.get_group_wake_status(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,   -- 그날 첫 기상 알람 시각
  rang_at           timestamptz,   -- 기상 알람이 처음 울린 시각
  snooze_count      integer,       -- 미루기 횟수
  dismissed_at      timestamptz,   -- 알람 해제 시각 (기상 확인 아님, 4.7)
  wake_confirmed_at timestamptz,   -- 기상 확인 시각
  missed_at         timestamptz,   -- 기상 확인 없이 놓친 시각
  wake_status       text           -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_tz   text;
  v_date date;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if v_uid is null or not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = v_uid
      and gm.invite_status = 'JOINED'
  ) then
    return;
  end if;

  select p.timezone into v_tz
  from public.profiles p
  where p.user_id = v_uid;

  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := coalesce(p_date, (now() at time zone v_tz)::date);
  v_from := v_date::timestamp at time zone v_tz;
  v_to   := (v_date + 1)::timestamp at time zone v_tz;

  -- 그 날 이 그룹의 약속이 없으면 빈 결과 (F4)
  if not exists (
    select 1
    from public.appointments ap
    where ap.group_id = p_group_id
      and ap.appointment_at >= v_from
      and ap.appointment_at <  v_to
  ) then
    return;
  end if;

  return query
  with members as (
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.invite_status = 'JOINED'
      and (gm.user_id = v_uid
           or (gm.wake_share_opt_in and not private.is_blocked_pair(v_uid, gm.user_id)))
  ),
  wake_alarms as (
    select a.user_id, min(a.scheduled_at) as first_at
    from public.alarms a
    where a.user_id in (select m.user_id from members m)
      and a.alarm_type = 'WAKE'
      and a.is_enabled
      and a.scheduled_at >= v_from
      and a.scheduled_at <  v_to
    group by a.user_id
  ),
  wake_events as (
    select e.user_id,
           min(e.event_at) filter (where e.event_type = 'TRIGGERED' and a.alarm_type = 'WAKE') as rang_at,
           count(*)        filter (where e.event_type = 'SNOOZED'   and a.alarm_type = 'WAKE') as snoozes,
           min(e.event_at) filter (where e.event_type = 'DISMISSED' and a.alarm_type = 'WAKE') as dismissed_at,
           min(e.event_at) filter (where e.event_type = 'WAKE_CONFIRMED')                      as confirmed_at,
           min(e.event_at) filter (where e.event_type = 'MISSED'    and a.alarm_type = 'WAKE') as missed_at
    from public.alarm_events e
    join public.alarms a on a.alarm_id = e.alarm_id
    where e.user_id in (select m.user_id from members m)
      and e.event_at >= v_from
      and e.event_at <  v_to
    group by e.user_id
  ),
  merged as (
    -- 알람이 울린 뒤 다음 회차로 옮겨졌으면 첫 울림 시각을 알람 시각으로 씀
    -- 기상 확인은 이벤트가 없으면 daily_records 값을 씀
    select m.user_id,
           coalesce(wa.first_at, we.rang_at)               as alarm_at,
           we.rang_at,
           coalesce(we.snoozes, 0)::integer                as snoozes,
           we.dismissed_at,
           coalesce(we.confirmed_at, dr.wake_confirmed_at) as confirmed_at,
           we.missed_at
    from members m
    left join wake_alarms wa on wa.user_id = m.user_id
    left join wake_events we on we.user_id = m.user_id
    left join public.daily_records dr on dr.user_id = m.user_id and dr.record_date = v_date
  )
  select x.user_id,
         p.nickname,
         p.profile_image_url,
         x.user_id = v_uid,
         x.alarm_at,
         x.rang_at,
         x.snoozes,
         x.dismissed_at,
         x.confirmed_at,
         x.missed_at,
         case
           when x.confirmed_at is not null then 'CONFIRMED'
           when x.missed_at    is not null then 'MISSED'
           when x.dismissed_at is not null then 'DISMISSED'
           when x.rang_at      is not null then 'RINGING'
           when x.alarm_at     is not null then 'SCHEDULED'
           else 'NO_ALARM'
         end
  from merged x
  join public.profiles p on p.user_id = x.user_id
  order by x.user_id = v_uid desc, p.nickname;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function
  private.normalize_sharing_permission(),
  private.grant_default_group_view()
from public, anon, authenticated;

revoke execute on function public.save_group_permissions(uuid, boolean, boolean) from public, anon;
grant execute on function public.save_group_permissions(uuid, boolean, boolean) to authenticated;
