-- =====================================================================
-- DB 보완 ② 그룹 · 공유 (10/15 작업 계획 P3 — 전체작업계획_v1.md 8절)
--   ④ G04 약속 정보          get_shared_alarm_appointments()  공유받은 알람의 약속 제목 · 장소 · 시각 (screen-data-map G04)
--   ⑤ 그룹 기상 상태         get_group_wake_status()          그 그룹에 약속이 있는 날에만 결과를 줌 (F4 · D57)
--   ⑥ 기상 신호 (Q3 A)       alarm_events에 기상 기록이 들어오면 약속 있는 그룹 채널에 "새로 고침" 신호만 보냄
-- =====================================================================


-- ---------------------------------------------------------------------
-- ④ G04 공유받은 알람의 약속 정보
-- ---------------------------------------------------------------------
-- 친구 알람 목록(G04)에 약속 제목 · 장소 · 시각을 보이려면 appointments를 읽어야 하는데,
-- appointments RLS는 만든 사람 · 그룹원만 보여 주고 참여 조건(appointment_participants)은 본인 행만 보임
-- → 호출자가 조회 권한(VIEW_ALARM, 친구 ∪ 그룹)을 받은 사람의 알람에 한해 약속 3칸만 돌려줌
--   판정은 RLS와 같은 private.granted_owner_ids('VIEW_ALARM')를 씀 (권한 회수 · 친구 해제 · 그룹 나감이 바로 반영됨)
--   약속 메모 · 출발지 · 이동 · 준비 값은 안 돌려줌. 약속이 없는 알람(일정 없는 알람 · 루틴 알람)은 행이 없음
-- p_owner_id를 주면 그 사람 알람만, 안 주면 조회 권한을 받은 모든 사람
create function public.get_shared_alarm_appointments(p_owner_id uuid default null)
returns table (
  alarm_id       uuid,
  user_id        uuid,          -- 알람 주인
  appointment_id uuid,
  title          varchar,
  dest_name      varchar,       -- 장소 이름
  appointment_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.alarm_id,
         a.user_id,
         ap.appointment_id,
         ap.title,
         ap.dest_name,
         ap.appointment_at
  from public.alarms a
  join public.appointment_participants pt on pt.participant_id = a.participant_id
  join public.appointments ap on ap.appointment_id = pt.appointment_id
  where a.user_id in (select private.granted_owner_ids('VIEW_ALARM'))
    and (p_owner_id is null or a.user_id = p_owner_id)
  order by ap.appointment_at, a.scheduled_at;
$$;


-- ---------------------------------------------------------------------
-- ⑤ 그룹원 기상 상태 — 그 그룹에 약속이 있는 날에만 (F4 · D57)
-- ---------------------------------------------------------------------
-- 지난 정의(mockup_extras ③)와 같고, 날짜 계산 뒤에 "그 날(호출자 시간대) 이 그룹의 약속이 있는지" 확인하는 부분만 더함
--   매일 추적하는 앱이 아니므로, 약속이 없는 날은 그룹원 기상 상태를 한 줄도 주지 않음
--   약속의 날짜는 appointments.appointment_at 기준임 (반복 약속의 다음 회차는 D4 뒤)
-- 하루 경계는 0시 그대로 (F7), 기상 공유 동의(wake_share_opt_in) 판정도 그대로 (D19 열림)
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
           or gm.user_id in (select private.granted_owner_ids('VIEW_WAKE')))
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
-- ⑥ 기상 신호 (Q3 A) — "새로 고침" 신호만 보내고, 받은 앱이 get_group_wake_status를 다시 부름
-- ---------------------------------------------------------------------
-- alarm_events는 본인만 읽을 수 있어서 남의 기록을 Realtime으로 직접 받을 수 없음 → DB가 그룹 채널에 신호만 보냄
--   채널   group:<group_id>:wake (비공개 채널)       이벤트 refresh        내용 {"date": "2026-10-15"} (누구의 기록인지 · 값은 안 담음)
--   보내는 때  기상 알람의 울림 · 미루기 · 해제 · 미확인(MISSED), 알람 종류와 상관없는 기상 확인(WAKE_CONFIRMED)
--              = get_group_wake_status의 결과가 바뀔 수 있는 기록과 같음
--   보내는 곳  기록한 사람이 참여 중(JOINED)이고, 기록한 날(그 사람 시간대)에 약속이 있는 그룹만 (F4 — 매일 추적하지 않음)
--   기상 공유 동의(wake_share_opt_in)는 보지 않음 (D19 열림). 신호에는 누구의 기록인지가 없고, 값은 함수가 권한을 보고 줌
-- 받기: realtime.messages 정책 — 그 그룹에 참여 중인 사람만. 클라이언트가 이 채널로 보내는 정책은 없음
-- 신호는 덤이라 보내기가 실패해도 기록(alarm_events) 저장은 막지 않음

create function private.send_wake_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_date  date;
  v_from  timestamptz;
  v_to    timestamptz;
  v_group uuid;
begin
  if new.event_type not in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED', 'WAKE_CONFIRMED') then
    return null;
  end if;
  -- 울림 · 미루기 · 해제 · 미확인은 기상 알람 것만 (기상 확인은 get_group_wake_status가 알람 종류를 안 봄)
  if new.event_type <> 'WAKE_CONFIRMED' and not exists (
    select 1 from public.alarms a
    where a.alarm_id = new.alarm_id and a.alarm_type = 'WAKE'
  ) then
    return null;
  end if;

  select p.timezone into v_tz
  from public.profiles p
  where p.user_id = new.user_id;

  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := (new.event_at at time zone v_tz)::date;
  v_from := v_date::timestamp at time zone v_tz;
  v_to   := (v_date + 1)::timestamp at time zone v_tz;

  for v_group in
    select gm.group_id
    from public.group_members gm
    where gm.user_id = new.user_id
      and gm.invite_status = 'JOINED'
      and exists (
        select 1
        from public.appointments ap
        where ap.group_id = gm.group_id
          and ap.appointment_at >= v_from
          and ap.appointment_at <  v_to
      )
  loop
    begin
      perform realtime.send(jsonb_build_object('date', v_date), 'refresh', 'group:' || v_group || ':wake', true);
    exception when others then
      raise warning '기상 신호를 보내지 못함 (group %): %', v_group, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

-- Realtime(realtime 스키마)이 있는 DB에만 건다: 실제 Supabase에는 항상 있음.
-- 없는 곳(realtime 서비스 없이 DB만 띄운 곳 · PGlite 같은 검사용 DB)에서는 마이그레이션이 실패하지 않게 건너뜀.
-- supabase/tests는 realtime.send · realtime.messages · realtime.topic 흉내를 만들어 이 경로도 검사함
do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    create trigger send_wake_signal after insert on public.alarm_events
      for each row execute function private.send_wake_signal();
  end if;
end;
$$;

-- 받는 쪽 정책: 채널 이름이 group:<uuid>:wake 모양이고 그 그룹에 참여 중인 사람만 받음 (모양이 다르면 uuid 변환을 시도하지 않음)
-- realtime.messages는 Supabase가 관리하는 표라 권한이 모자라면 경고만 남기고 넘어감 (마이그레이션 하나가 막혀 뒤 파일이 못 들어가는 일을 피함)
--   → 이 경고가 보이면 같은 create policy 문을 SQL 편집기에서 직접 실행함 (supabase/README.md "그룹 기상 신호")
do $$
begin
  if to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null then
    drop policy if exists wake_signal_receive on realtime.messages;
    create policy wake_signal_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and case
              when realtime.topic() ~ '^group:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:wake$'
                then private.is_group_member(split_part(realtime.topic(), ':', 2)::uuid)
              else false
            end
      );
  end if;
exception when insufficient_privilege then
  raise warning 'realtime.messages에 기상 신호 받기 정책을 만들 권한이 없음 — supabase/README.md "그룹 기상 신호"의 SQL을 SQL 편집기에서 직접 실행: %', sqlerrm;
end;
$$;


-- ---------------------------------------------------------------------
-- 실행 권한 — 앱(authenticated)만. 트리거 함수는 실행 권한이 없어도 트리거로는 돎
-- ---------------------------------------------------------------------

revoke execute on function public.get_shared_alarm_appointments(uuid) from public, anon, authenticated;
revoke execute on function private.send_wake_signal() from public, anon, authenticated;
grant execute on function public.get_shared_alarm_appointments(uuid) to authenticated;
