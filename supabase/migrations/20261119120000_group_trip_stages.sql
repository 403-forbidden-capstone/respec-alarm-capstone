-- 그룹 화면에 출발 · 도착 단계 다시 넣기 — 서버 (11/19 지형님)
--   D59 '기상까지만'을 '도착까지'로 바꿈. 출발 · 도착은 시각만(장소 · 좌표 · 감지 출처 · 지각 여부는 안 돌려줌)
--   ① 출발 · 도착 공유 동의    group_members.trip_share_opt_in (기본 끔). 기상 공유를 켠 사람만 켤 수 있고, 기상 공유를 끄면 같이 꺼짐
--   ② 그룹 기상 조회             private.group_wake_rows · get_group_wake · get_group_wake_status에 departed_at · arrived_at · trip_visible 추가
--                                그날 이 그룹 공동 약속 중 그 멤버가 참여한 것. 여러 개면 아직 도착 안 한 것 중 가장 이른 약속, 다 도착했으면 가장 늦은 약속
--                                trip_visible = 그 멤버(본인 포함)가 출발 · 도착 공유를 켬 + 그날 참여 행이 있음. false면 시각은 null
--                                자동 기상 판정의 20분 지연(D61)은 기상에만 그대로 — 출발 · 도착은 버튼 · 위치 모두 바로 보임
--   ③ 이른 위치 출발 막기        위치(LOCATION)로 들어온 출발이 출발 예정 − 60분보다 이르면 조용히 무시(앞 값 유지). 11/19 시험의 부팅 직후 '3시간 전 출발' 대응
--   ④ 원탭 서버 반영            alarm_events가 올라오면 서버가 바로 appointment_participants의 출발 · 도착 · 준비 시작을 채움 (알림 버튼이 앱을 안 열고 올라오는 경우)
--                                빈 칸만 채움 · 지각 판정은 앱 judgeArrival과 같음. 위치 값을 응답으로 덮는 일은 앱 follow-up 몫 — 앱이 같은 값으로 나중에 와도 결과가 같음(멱등)
--   ⑤ 실시간 신호                출발 · 도착이 바뀌면 그 그룹에 '새로 고침' 신호 (send_wake_signal과 같은 채널 · 내용)
-- 함수 본문은 지난 마이그레이션(wake_status · wake_hardening · explore_fixes)과 같고 위 이유로 달라진 곳에만 주석을 닮

-- ---------------------------------------------------------------------
-- 1. 출발 · 도착 공유 동의
-- ---------------------------------------------------------------------

alter table public.group_members
  add column trip_share_opt_in boolean not null default false;

comment on column public.group_members.trip_share_opt_in is '이 그룹에 출발 · 도착 시각 공유 동의 (기본 끔). 기상 공유(wake_share_opt_in)를 켠 사람만 켤 수 있고, 기상 공유를 끄거나 그룹을 나가면 같이 꺼짐';

-- 본인 행 갱신은 기존 정책(group_members_update_self, 행 단위)이 그대로 덮음 — 칸이 늘어도 정책은 안 바뀜

-- 기상 공유가 꺼져 있거나 참여 중이 아니면 출발 · 도착 공유도 꺼 둠 (INSERT · UPDATE, 누가 바꾸든)
create function private.sync_trip_share_opt_in()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trip_share_opt_in and (new.invite_status <> 'JOINED' or not new.wake_share_opt_in) then
    new.trip_share_opt_in := false;
  end if;
  return new;
end;
$$;

create trigger sync_trip_share_opt_in
  before insert or update on public.group_members
  for each row execute function private.sync_trip_share_opt_in();

revoke execute on function private.sync_trip_share_opt_in() from public, anon, authenticated;

-- 구성원 행 보호(friend_groups 3절)와 같고 달라진 곳: 참여 중이 아닐 때 바꿀 수 없는 칸에 trip_share_opt_in 추가
create or replace function private.guard_group_member_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.invited_by := (select auth.uid());
      new.invited_at := now();
      new.notifications_off := false;
    else
      if new.invite_status is distinct from old.invite_status and not (old.invite_status = 'JOINED' and new.invite_status = 'LEFT') then
        raise exception '그룹 상태는 나가기 말고 함수로만 바뀜' using errcode = '42501';
      end if;
      if new.joined_at is distinct from old.joined_at or new.invited_by is distinct from old.invited_by or new.invited_at is distinct from old.invited_at then
        raise exception '참여 일시 · 초대 기록은 바꿀 수 없음' using errcode = '42501';
      end if;
      if old.invite_status <> 'JOINED'
         and (new.wake_share_opt_in is distinct from old.wake_share_opt_in
              or new.trip_share_opt_in is distinct from old.trip_share_opt_in
              or new.notifications_off is distinct from old.notifications_off) then
        raise exception '참여 중일 때만 바꿀 수 있음' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. 그룹 기상 조회에 출발 · 도착 (반환형이 바뀌어 지우고 다시 만듦)
-- ---------------------------------------------------------------------

drop function public.get_group_wake(uuid, date);
drop function public.get_group_wake_status(uuid, date);
drop function private.group_wake_rows(uuid, uuid, date, timestamptz);

create function private.group_wake_rows(p_viewer uuid, p_group_id uuid, p_date date default null, p_now timestamptz default now())
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,
  rang_at           timestamptz,
  snooze_count      integer,
  dismissed_at      timestamptz,
  wake_confirmed_at timestamptz,
  missed_at         timestamptz,
  wake_status       text,
  confirm_pending   boolean,      -- 자동 판정 확인이 있는데 아직 20분이 안 지나 다른 사람에게 안 보이는 중 (8장 깨우기가 '이미 일어났어요'로 막을 때 씀)
  departed_at       timestamptz,  -- 그날 이 그룹 약속의 출발 시각 (trip_visible일 때만, 아니면 null)
  arrived_at        timestamptz,  -- 같은 약속의 도착 시각
  trip_visible      boolean,      -- 그 멤버가 이 그룹에서 출발 · 도착 공유를 켰고(본인도 같음) 그날 이 그룹 공동 약속에 참여 행이 있음
  trip_appointment_at timestamptz -- 시각을 고른 약속의 appointment_at (trip_visible이 false면 null)
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz   text;
  v_date date;
begin
  if p_viewer is null or p_group_id is null or not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_viewer and gm.invite_status = 'JOINED'
  ) then
    return;
  end if;

  select p.timezone into v_tz from public.profiles p where p.user_id = p_viewer;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := coalesce(p_date, (p_now at time zone v_tz)::date);

  if not private.group_wake_has_meeting(p_group_id, v_date, v_tz) then
    return;
  end if;

  return query
  with members as (
    select gm.user_id,
           gm.trip_share_opt_in                                                       as trip_opt,
           coalesce(pr.timezone, 'Asia/Seoul')                                         as tz,
           (v_date::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul'))       as w_from,
           ((v_date + 1)::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')) as w_to
    from public.group_members gm
    join public.profiles pr on pr.user_id = gm.user_id
    where gm.group_id = p_group_id
      and gm.invite_status = 'JOINED'
      and (gm.user_id = p_viewer or private.can_see_wake(p_viewer, gm.user_id, p_group_id))
  ),
  day_alarms as (
    select a.alarm_id, a.user_id, a.scheduled_at
    from public.alarms a
    join members m on m.user_id = a.user_id
    where a.alarm_type = 'WAKE'
      and private.wake_alarm_counts(a.alarm_id, a.is_enabled, a.scheduled_at)
      and a.scheduled_at >= m.w_from
      and a.scheduled_at <  m.w_to
  ),
  first_alarm as (
    select distinct on (d.user_id) d.user_id, d.alarm_id, d.scheduled_at
    from day_alarms d
    order by d.user_id, d.scheduled_at, d.alarm_id
  ),
  ev as (
    select d.user_id, (d.alarm_id = f.alarm_id) as is_first, e.event_type, e.event_at, e.snooze_minutes
    from day_alarms d
    join first_alarm f on f.user_id = d.user_id
    join public.alarm_events e on e.alarm_id = d.alarm_id
      and e.event_type in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED')
      and e.event_at >= d.scheduled_at - interval '6 hours'
      and e.event_at <  d.scheduled_at + interval '18 hours'
  ),
  agg as (
    select ev.user_id,
           min(ev.event_at) filter (where ev.event_type = 'TRIGGERED') as rang_at,
           (count(*) filter (where ev.event_type = 'SNOOZED'))::integer as snoozes,
           min(ev.event_at) filter (where ev.event_type = 'DISMISSED') as dismissed_at,
           min(ev.event_at) filter (where ev.event_type = 'MISSED')    as missed_event_at,
           max(ev.event_at + make_interval(mins => coalesce(ev.snooze_minutes, 0))) filter (where ev.event_type = 'SNOOZED' and ev.is_first) as last_snooze_end
    from ev
    group by ev.user_id
  ),
  conf as (
    select f.user_id,
           min(e.event_at) filter (where vis.ok) as confirmed_at,
           coalesce(bool_or(not vis.ok), false)  as pending
    from first_alarm f
    join members m on m.user_id = f.user_id
    join public.alarm_events e on e.user_id = f.user_id
      and e.event_type = 'WAKE_CONFIRMED'
      and e.event_at >= m.w_from - interval '1 day'
      and e.event_at <  m.w_to   + interval '1 day'
      and coalesce(e.input_source::text, '') not in ('MANUAL', 'VOICE')
      and private.wake_day(e.alarm_id, e.event_at, m.tz) = v_date
    cross join lateral (
      select (f.user_id = p_viewer
              or e.input_source is distinct from 'USAGE'
              or e.event_at <= p_now - interval '20 minutes') as ok
    ) vis
    group by f.user_id
  ),
  -- 출발 · 도착 = 그날(그 멤버 시간대) 이 그룹 공동 약속 중 그 멤버가 참여한 것. 20분 지연 없음(D61은 기상에만).
  --   여러 개면 출발 · 도착 기록이 가장 최근인 약속(기록이 하나도 없으면 가장 이른 약속, 시각은 null). 본인도 출발 · 도착 공유를 켠 사람만 (아니면 조인이 안 붙어 null)
  trip as (
    select m.user_id, t.departed_at, t.arrived_at, t.appointment_at
    from members m
    cross join lateral (
      select pt.departed_at, pt.arrived_at, ap.appointment_at
      from public.appointment_participants pt
      join public.appointments ap on ap.appointment_id = pt.appointment_id
      where pt.user_id = m.user_id
        and ap.group_id = p_group_id
        and ap.appointment_at >= m.w_from
        and ap.appointment_at <  m.w_to
      order by greatest(pt.departed_at, pt.arrived_at) desc nulls last,
               ap.appointment_at,
               pt.participant_id
      limit 1
    ) t
    where m.trip_opt
  )
  select m.user_id,
         pr.nickname,
         pr.profile_image_url,
         (m.user_id = p_viewer),
         f.scheduled_at,
         ag.rang_at,
         coalesce(ag.snoozes, 0)::integer,
         ag.dismissed_at,
         c.confirmed_at,
         case
           when c.confirmed_at is not null or f.alarm_id is null then null
           when ag.missed_event_at is not null then ag.missed_event_at
           when not coalesce(c.pending, false) and p_now >= due.due_at then due.due_at
         end,
         case
           when c.confirmed_at is not null then 'CONFIRMED'
           when f.alarm_id is null then 'NO_ALARM'
           when ag.missed_event_at is not null or (not coalesce(c.pending, false) and p_now >= due.due_at) then 'MISSED'
           when ag.dismissed_at is not null then 'DISMISSED'
           when ag.rang_at is not null then 'RINGING'
           else 'SCHEDULED'
         end,
         coalesce(c.pending, false),
         tr.departed_at,
         tr.arrived_at,
         (m.trip_opt and tr.user_id is not null),
         case when m.trip_opt then tr.appointment_at end
  from members m
  join public.profiles pr on pr.user_id = m.user_id
  left join first_alarm f on f.user_id = m.user_id
  left join agg ag on ag.user_id = m.user_id
  left join conf c on c.user_id = m.user_id
  left join trip tr on tr.user_id = m.user_id
  cross join lateral (
    select greatest(f.scheduled_at, coalesce(ag.last_snooze_end, f.scheduled_at)) + interval '30 minutes' as due_at
  ) due
  order by (m.user_id = p_viewer) desc, pr.nickname;
end;
$$;

-- 앱이 부르는 줄인 응답: 단계 · 알람 시각 · 확인 시각 + 출발 · 도착 시각 (장소 · 좌표 · 출처 · 지각은 안 돌려줌)
create function public.get_group_wake(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,
  wake_confirmed_at timestamptz,
  wake_status       text,         -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
  departed_at       timestamptz,  -- 출발 시각 (trip_visible이 false면 null)
  arrived_at        timestamptz,  -- 도착 시각 (trip_visible이 false면 null)
  trip_visible      boolean,      -- 출발 · 도착 공유를 켰고 그날 이 그룹 약속에 참여함
  trip_appointment_at timestamptz -- 시각을 고른 약속의 appointment_at (trip_visible이 false면 null)
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at, r.wake_confirmed_at, r.wake_status,
         r.departed_at, r.arrived_at, r.trip_visible, r.trip_appointment_at
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

-- 옛 모양 호환 — 11칸 뒤에 출발 · 도착 3칸. 내 줄만 울린 시각 · 미루기 · 해제 · 미확인 칸이 차고 다른 사람 줄은 비어 있음(미루기 0)
create function public.get_group_wake_status(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,   -- 그날 첫 기상 알람 시각
  rang_at           timestamptz,   -- 기상 알람이 처음 울린 시각 (내 줄만)
  snooze_count      integer,       -- 미루기 횟수 (내 줄만, 남은 0)
  dismissed_at      timestamptz,   -- 알람 해제 시각 (내 줄만)
  wake_confirmed_at timestamptz,   -- 기상 확인 시각
  missed_at         timestamptz,   -- 기상 확인 없이 놓친 시각 (내 줄만)
  wake_status       text,          -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
  departed_at       timestamptz,   -- 출발 시각 (trip_visible이 false면 null)
  arrived_at        timestamptz,   -- 도착 시각 (trip_visible이 false면 null)
  trip_visible      boolean,
  trip_appointment_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at,
         case when r.is_me then r.rang_at end,
         case when r.is_me then r.snooze_count else 0 end,
         case when r.is_me then r.dismissed_at end,
         r.wake_confirmed_at,
         case when r.is_me then r.missed_at end,
         r.wake_status,
         r.departed_at, r.arrived_at, r.trip_visible, r.trip_appointment_at
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

revoke execute on function private.group_wake_rows(uuid, uuid, date, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_group_wake(uuid, date) from public, anon;
revoke execute on function public.get_group_wake_status(uuid, date) from public, anon;
grant execute on function public.get_group_wake(uuid, date) to authenticated;
grant execute on function public.get_group_wake_status(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 이른 위치 출발 막기
-- ---------------------------------------------------------------------

-- 위치(LOCATION)로 들어온 출발이 출발 예정 − 60분(감시 창 시작, 앱 WINDOW_BEFORE_DEPART_MINUTES)보다 이르면 앞 값(departed_at · departed_source)을 그대로 둠.
--   오류를 내지 않고 조용히 통과 — 앱 동기화가 같은 값으로 반복해서 실패하지 않게
--   출발 예정 = 그 참여 조건의 출발 알람 시각, 없으면 약속 − (여유 + 이동시간) (앱 features/location/regions plannedDepartAt 과 같음)
create function private.guard_early_location_departure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt   timestamptz;
  v_depart timestamptz;
begin
  if new.departed_source is distinct from 'LOCATION' or new.departed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.departed_at is not distinct from old.departed_at then
    return new;
  end if;

  select ap.appointment_at into v_appt from public.appointments ap where ap.appointment_id = new.appointment_id;
  if v_appt is null then
    return new;
  end if;

  select a.scheduled_at into v_depart
  from public.alarms a
  where a.participant_id = new.participant_id and a.alarm_type = 'DEPARTURE';
  v_depart := coalesce(v_depart, v_appt - make_interval(mins => new.buffer_minutes + coalesce(new.est_travel_minutes, 0)));

  if new.departed_at < v_depart - interval '60 minutes' then
    if tg_op = 'UPDATE' then
      new.departed_at     := old.departed_at;
      new.departed_source := old.departed_source;
    else
      new.departed_at     := null;
      new.departed_source := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_early_location_departure
  before insert or update on public.appointment_participants
  for each row execute function private.guard_early_location_departure();

revoke execute on function private.guard_early_location_departure() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. 원탭을 서버에서 바로 반영
-- ---------------------------------------------------------------------

-- 앱 oneTap.ts · prepareStart.ts가 읽는 것과 같은 기록:
--   · 출발  = ACKNOWLEDGED + 알람 종류 DEPARTURE          → departed_at · departed_source BUTTON
--   · 도착  = ARRIVAL_CONFIRMED + 알람 종류 ARRIVE         → arrived_at · arrived_source BUTTON (+ 지각 판정)
--   · 준비 시작 = DISMISSED 또는 ACKNOWLEDGED + 알람 종류 PREPARE → prepare_started_at · prepare_started_source PREPARE_ALARM (비어 있을 때만)
--   출처(input_source)가 BUTTON이거나 비어 있는 것만 — 위치(LOCATION)로 쓴 기록은 앱이 시각을 직접 쓰면서 같이 남기는 것이라 다시 반영하지 않음
-- 빈 칸만 채움(departed_at · arrived_at이 null일 때만). 위치 값을 응답으로 덮는 일은 앱 follow-up(decideWrite)에 맡김 — 서버가 덮으면 앱이 준비 실측 · 이동시간을 다시 셈할 수 없음.
-- 지각은 응답 도착 규칙(약속 + 5분 초과, judgeArrival)대로 같이 씀. 준비 실측 · 이동시간 계산은 안 함 — 앱이 같은 값으로 다시 와도
--   값이 이미 있어 'keep'이고, 준비 실측 · 이동시간은 앱이 저장된 값을 읽어 셈하므로 결과가 같음(멱등)
create function private.apply_participant_times_from_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type public.alarm_type;
  v_pid  uuid;
begin
  if new.event_type not in ('ACKNOWLEDGED', 'ARRIVAL_CONFIRMED', 'DISMISSED') then
    return null;
  end if;

  select a.alarm_type, a.participant_id into v_type, v_pid
  from public.alarms a
  where a.alarm_id = new.alarm_id and a.user_id = new.user_id;
  if v_pid is null then
    return null;                                  -- 지워진 알람 · 루틴 · 일정 없는 알람
  end if;

  if new.event_type = 'ACKNOWLEDGED' and v_type = 'DEPARTURE' and coalesce(new.input_source::text, 'BUTTON') = 'BUTTON' then
    update public.appointment_participants pt
    set departed_at = new.event_at,
        departed_source = 'BUTTON'
    where pt.participant_id = v_pid and pt.user_id = new.user_id
      and pt.departed_at is null;

  elsif new.event_type = 'ARRIVAL_CONFIRMED' and v_type = 'ARRIVE' and coalesce(new.input_source::text, 'BUTTON') = 'BUTTON' then
    update public.appointment_participants pt
    set arrived_at = new.event_at,
        arrived_source = 'BUTTON',
        is_late = (new.event_at - ap.appointment_at > interval '5 minutes'),
        late_minutes = case
          when new.event_at - ap.appointment_at > interval '5 minutes'
            then round(extract(epoch from (new.event_at - ap.appointment_at)) / 60.0)::integer
          else 0
        end
    from public.appointments ap
    where ap.appointment_id = pt.appointment_id
      and pt.participant_id = v_pid and pt.user_id = new.user_id
      and pt.arrived_at is null;

  elsif new.event_type in ('DISMISSED', 'ACKNOWLEDGED') and v_type = 'PREPARE' then
    update public.appointment_participants pt
    set prepare_started_at = new.event_at,
        prepare_started_source = 'PREPARE_ALARM'
    where pt.participant_id = v_pid and pt.user_id = new.user_id
      and pt.prepare_started_at is null;
  end if;

  return null;
end;
$$;

create trigger apply_participant_times_from_event
  after insert on public.alarm_events
  for each row execute function private.apply_participant_times_from_event();

revoke execute on function private.apply_participant_times_from_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. 출발 · 도착이 바뀌면 그룹 새로 고침 신호
-- ---------------------------------------------------------------------

-- send_wake_signal(friend_wake_status 5절)과 같은 채널 · 내용: group:<id>:wake · refresh · {date}.
--   보내는 조건: 그룹 공동 약속이고, 그 멤버가 이 그룹에서 기상 · 출발 · 도착 공유를 켰고, 그날 이 그룹에 약속이 있음. 날짜 = 약속 날짜(그 멤버 시간대)
--   값이 지워질 때([아니에요])도 바뀐 것이라 보냄
create function private.send_trip_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid;
  v_appt  timestamptz;
  v_tz    text;
  v_date  date;
begin
  if tg_op = 'UPDATE' and new.departed_at is not distinct from old.departed_at and new.arrived_at is not distinct from old.arrived_at then
    return null;
  end if;

  select ap.group_id, ap.appointment_at into v_group, v_appt
  from public.appointments ap where ap.appointment_id = new.appointment_id;
  if v_group is null or v_appt is null then
    return null;
  end if;

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := (v_appt at time zone v_tz)::date;

  if exists (
       select 1 from public.group_members gm
       where gm.group_id = v_group and gm.user_id = new.user_id
         and gm.invite_status = 'JOINED' and gm.wake_share_opt_in and gm.trip_share_opt_in)
     and private.group_wake_has_meeting(v_group, v_date, v_tz) then
    begin
      perform realtime.send(jsonb_build_object('date', v_date), 'refresh', 'group:' || v_group || ':wake', true);
    exception when others then
      raise warning '출발 · 도착 신호를 보내지 못함 (group %): %', v_group, sqlerrm;
    end;
  end if;

  return null;
end;
$$;

revoke execute on function private.send_trip_signal() from public, anon, authenticated;

-- Realtime이 있는 DB에만 건다 (send_wake_signal과 같은 이유 — PGlite 검사는 realtime.send 흉내를 둠)
do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    create trigger send_trip_signal after insert or update of departed_at, arrived_at on public.appointment_participants
      for each row execute function private.send_trip_signal();
  end if;
end;
$$;
