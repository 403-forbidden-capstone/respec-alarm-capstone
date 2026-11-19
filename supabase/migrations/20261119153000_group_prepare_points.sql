-- 그룹 포인트 — 준비 · 출발 알람 해제 반영 · 준비 시각 칸 · 새로 고침 신호 (11/19 지형님: 세 알람 모두 진짜 알람)
--   기상 · 준비 · 출발 알람이 모두 진짜 알람(미루기 · 해제). 그룹 포인트 = 알람 뒤 체크 — 준비 알람 해제 = 준비 시작, 출발 알람 해제 = 출발
--   ① 해제 반영             alarm_events DISMISSED가 PREPARE 알람이면 prepare_started_at, DEPARTURE 알람이면 departed_at(+ departed_source BUTTON)을 빈 칸일 때만 채움
--                            기존 ACKNOWLEDGED 반영(옛 앱 · 알림 버튼)은 그대로. 버튼 · 알람 응답이 위치보다 우선(위치 출발은 이 값이 있으면 앱이 덮지 않음 · 서버는 빈 칸만),
--                            이른 위치 출발 막기(BEFORE 트리거)도 그대로
--   ② 그룹 조회 새 칸        private.group_wake_rows · get_group_wake · get_group_wake_status 끝에 prepare_alarm_at · prepare_started_at
--                            trip_appointment_at과 같은 약속 고르기 규칙. trip_visible이 아니면 둘 다 null. prepare_alarm_at = 그 사람 그 약속의 켜진 PREPARE 알람 시각
--   ③ 새로 고침 신호         group:<id>:wake · refresh · {date} (send_wake_signal · send_trip_signal과 같은 모양). 값만 바뀐 그룹에, 하나의 변경에 한 번
--                            준비 시작 바뀜 · 공유(기상 · 출발 · 도착) 바뀜 · 나가기 / 내보내짐 · 약속에서 빠짐 · 약속 시각 변경 / 취소 · 기상 숨기기 / 보이기

-- ---------------------------------------------------------------------
-- 1. 해제 → 참여 행 반영
-- ---------------------------------------------------------------------

-- 지난 정의(group_trip_stages 4절)와 같고 달라진 곳: DISMISSED + DEPARTURE 알람 → departed_at · departed_source (출처 BUTTON이거나 비어 있는 것만, 빈 칸일 때만)
create or replace function private.apply_participant_times_from_event()
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

  if new.event_type in ('ACKNOWLEDGED', 'DISMISSED') and v_type = 'DEPARTURE' and coalesce(new.input_source::text, 'BUTTON') = 'BUTTON' then
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

-- ---------------------------------------------------------------------
-- 2. 그룹 조회에 준비 알람 시각 · 준비 시작 시각 (반환형이 바뀌어 지우고 다시 만듦, 칸 · 순서 그대로 + 끝에 2칸)
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
  trip_appointment_at timestamptz, -- 시각을 고른 약속의 appointment_at (trip_visible이 false면 null)
  prepare_alarm_at  timestamptz,  -- 같은 약속의 그 사람 켜진 PREPARE 알람 시각 (trip_visible이 false면 null)
  prepare_started_at timestamptz  -- 같은 약속 참여 행의 준비 시작 시각 (trip_visible이 false면 null)
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
    select m.user_id, t.departed_at, t.arrived_at, t.appointment_at, t.prepare_started_at,
           (select min(al.scheduled_at) from public.alarms al
            where al.participant_id = t.participant_id and al.alarm_type = 'PREPARE' and al.is_enabled) as prepare_alarm_at
    from members m
    cross join lateral (
      select pt.participant_id, pt.departed_at, pt.arrived_at, pt.prepare_started_at, ap.appointment_at
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
         case when m.trip_opt then tr.appointment_at end,
         tr.prepare_alarm_at,
         tr.prepare_started_at
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

-- 앱이 부르는 줄인 응답: 단계 · 알람 시각 · 확인 시각 + 출발 · 도착 시각 + 준비 알람 · 준비 시작 시각 (장소 · 좌표 · 출처 · 지각은 안 돌려줌)
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
  trip_appointment_at timestamptz, -- 시각을 고른 약속의 appointment_at (trip_visible이 false면 null)
  prepare_alarm_at  timestamptz,  -- 준비 알람 시각 (trip_visible이 false면 null)
  prepare_started_at timestamptz  -- 준비 시작 시각 (trip_visible이 false면 null)
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at, r.wake_confirmed_at, r.wake_status,
         r.departed_at, r.arrived_at, r.trip_visible, r.trip_appointment_at, r.prepare_alarm_at, r.prepare_started_at
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

-- 옛 모양 호환 — 11칸 뒤에 출발 · 도착 4칸 · 준비 2칸. 내 줄만 울린 시각 · 미루기 · 해제 · 미확인 칸이 차고 다른 사람 줄은 비어 있음(미루기 0)
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
  trip_appointment_at timestamptz,
  prepare_alarm_at  timestamptz,   -- 준비 알람 시각 (trip_visible이 false면 null)
  prepare_started_at timestamptz   -- 준비 시작 시각 (trip_visible이 false면 null)
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
         r.departed_at, r.arrived_at, r.trip_visible, r.trip_appointment_at, r.prepare_alarm_at, r.prepare_started_at
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

revoke execute on function private.group_wake_rows(uuid, uuid, date, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_group_wake(uuid, date) from public, anon;
revoke execute on function public.get_group_wake_status(uuid, date) from public, anon;
grant execute on function public.get_group_wake(uuid, date) to authenticated;
grant execute on function public.get_group_wake_status(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 새로 고침 신호
-- ---------------------------------------------------------------------

-- 신호 하나 보내기 — send_wake_signal · send_trip_signal과 같은 채널 · 내용(group:<id>:wake · refresh · {date}). 못 보내도 본 변경은 그대로
create function private.send_group_refresh(p_group_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_group_id is null or p_date is null then
    return;
  end if;
  begin
    perform realtime.send(jsonb_build_object('date', p_date), 'refresh', 'group:' || p_group_id || ':wake', true);
  exception when others then
    raise warning '그룹 새로 고침 신호를 보내지 못함 (group %): %', p_group_id, sqlerrm;
  end;
end;
$$;

revoke execute on function private.send_group_refresh(uuid, date) from public, anon, authenticated;

-- 약속 날짜가 따로 없는 변경(공유 · 나가기 · 숨기기)에 실을 날짜 — 오늘(시간대 기준)이 이 그룹 '약속 있는 날'이면 오늘, 아니면 가장 가까운 그룹 약속의 날짜, 약속이 하나도 없으면 null(보낼 화면이 없음)
create function private.group_signal_date(p_group_id uuid, p_tz text)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.group_wake_has_meeting(p_group_id, (now() at time zone coalesce(p_tz, 'Asia/Seoul'))::date, coalesce(p_tz, 'Asia/Seoul'))
      then (now() at time zone coalesce(p_tz, 'Asia/Seoul'))::date
    else (select (ap.appointment_at at time zone coalesce(p_tz, 'Asia/Seoul'))::date
          from public.appointments ap
          where ap.group_id = p_group_id
          order by abs(extract(epoch from (ap.appointment_at - now()))), ap.appointment_id
          limit 1)
  end;
$$;

revoke execute on function private.group_signal_date(uuid, text) from public, anon, authenticated;

-- ① 참여 행 — 지난 정의(group_trip_stages 5절)와 같고 달라진 곳:
--   · 준비 시작(prepare_started_at)이 바뀌어도 보냄 (출발 · 도착과 같은 조건: 기상 · 출발 · 도착 공유를 켠 사람)
--   · 약속에서 빠짐(행 지움)도 보냄 — 그 사람의 기상 줄이 알람 없음으로 바뀜. 기상 공유만 켜도 보임이 달라지므로 조건은 기상 공유
--     약속 · 그룹이 지워져 같이 지워지는 행(트리거 안쪽)은 안 보냄 — 약속 취소 신호(②)가 한 번 감
create or replace function private.send_trip_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.appointment_participants;
  v_group uuid;
  v_appt  timestamptz;
  v_tz    text;
  v_date  date;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return null;
    end if;
    v_row := old;
  else
    v_row := new;
    if tg_op = 'UPDATE'
       and new.departed_at is not distinct from old.departed_at
       and new.arrived_at is not distinct from old.arrived_at
       and new.prepare_started_at is not distinct from old.prepare_started_at then
      return null;
    end if;
  end if;

  select ap.group_id, ap.appointment_at into v_group, v_appt
  from public.appointments ap where ap.appointment_id = v_row.appointment_id;
  if v_group is null or v_appt is null then
    return null;
  end if;

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = v_row.user_id;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := (v_appt at time zone v_tz)::date;

  if exists (
       select 1 from public.group_members gm
       where gm.group_id = v_group and gm.user_id = v_row.user_id
         and gm.invite_status = 'JOINED' and gm.wake_share_opt_in
         and (tg_op = 'DELETE' or gm.trip_share_opt_in))
     and private.group_wake_has_meeting(v_group, v_date, v_tz) then
    perform private.send_group_refresh(v_group, v_date);
  end if;

  return null;
end;
$$;

-- 트리거를 다시 검 (칸 · 지움 추가) — Realtime이 있는 DB에만
do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    drop trigger if exists send_trip_signal on public.appointment_participants;
    create trigger send_trip_signal after insert or update of departed_at, arrived_at, prepare_started_at or delete on public.appointment_participants
      for each row execute function private.send_trip_signal();
  end if;
end;
$$;

-- ② 그룹 약속 — 시각이 바뀌거나(옛 날짜 · 새 날짜 화면) 취소되면(그 날짜 화면). 참여자 중 기상 공유를 켠 사람이 있을 때만
create function private.send_appointment_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 or old.group_id is null then
      return old;                                  -- 그룹 · 계정이 지워져 같이 지워지는 약속은 안 보냄
    end if;
  elsif new.group_id is null or new.appointment_at is not distinct from old.appointment_at then
    return null;
  end if;

  if exists (
       select 1
       from public.appointment_participants pt
       join public.group_members gm on gm.user_id = pt.user_id and gm.group_id = coalesce(new.group_id, old.group_id)
       where pt.appointment_id = coalesce(new.appointment_id, old.appointment_id)
         and gm.invite_status = 'JOINED' and gm.wake_share_opt_in) then
    -- 날짜 = 약속 날짜 (만든 사람 시간대)
    select coalesce(p.timezone, 'Asia/Seoul') into v_tz
    from public.profiles p where p.user_id = coalesce(new.creator_id, old.creator_id);
    v_tz := coalesce(v_tz, 'Asia/Seoul');
    if tg_op = 'DELETE' then
      perform private.send_group_refresh(old.group_id, (old.appointment_at at time zone v_tz)::date);
      return old;
    end if;
    perform private.send_group_refresh(new.group_id, (new.appointment_at at time zone v_tz)::date);
    if (old.appointment_at at time zone v_tz)::date <> (new.appointment_at at time zone v_tz)::date then
      perform private.send_group_refresh(new.group_id, (old.appointment_at at time zone v_tz)::date);   -- 날짜가 바뀌면 옛 날짜 화면도 비워야 함
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;

revoke execute on function private.send_appointment_signal() from public, anon, authenticated;

-- ③ 그룹 구성원 — 공유(기상 · 출발 · 도착) 켜기 · 끄기, 나가기(JOINED → LEFT) · 내보내짐(행 지움). 참여 중이던 사람 것만
create function private.send_member_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid;
  v_user  uuid;
  v_tz    text;
begin
  if tg_op = 'DELETE' then
    if old.invite_status <> 'JOINED' or pg_trigger_depth() > 1 then
      return old;                                  -- 참여 전 초대 취소 · 그룹이 지워져 같이 지워지는 행은 안 보냄
    end if;
    v_group := old.group_id;
    v_user  := old.user_id;
  else
    if not (old.invite_status = 'JOINED' or new.invite_status = 'JOINED')
       or (new.wake_share_opt_in is not distinct from old.wake_share_opt_in
           and new.trip_share_opt_in is not distinct from old.trip_share_opt_in
           and new.invite_status is not distinct from old.invite_status) then
      return null;
    end if;
    v_group := new.group_id;
    v_user  := new.user_id;
  end if;

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = v_user;
  perform private.send_group_refresh(v_group, private.group_signal_date(v_group, v_tz));

  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;

revoke execute on function private.send_member_signal() from public, anon, authenticated;

-- ④ 기상 숨기기 · 보이기 — 숨기는 사람(owner)이 기상 공유를 켜고, 둘이 같이 참여 중인 그룹마다 한 번
create function private.send_hide_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid := case when tg_op = 'DELETE' then old.owner_id else new.owner_id end;
  v_hidden uuid := case when tg_op = 'DELETE' then old.hidden_from_id else new.hidden_from_id end;
  v_tz     text;
  v_group  uuid;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;                                    -- 계정이 지워져 같이 지워지는 숨김은 안 보냄
  end if;

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = v_owner;
  for v_group in
    select go.group_id
    from public.group_members go
    join public.group_members gh on gh.group_id = go.group_id
    where go.user_id = v_owner  and go.invite_status = 'JOINED' and go.wake_share_opt_in
      and gh.user_id = v_hidden and gh.invite_status = 'JOINED'
  loop
    perform private.send_group_refresh(v_group, private.group_signal_date(v_group, v_tz));
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;

revoke execute on function private.send_hide_signal() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    create trigger send_appointment_time_signal after update of appointment_at on public.appointments
      for each row execute function private.send_appointment_signal();
    create trigger send_appointment_cancel_signal before delete on public.appointments
      for each row execute function private.send_appointment_signal();
    create trigger send_member_signal after update or delete on public.group_members
      for each row execute function private.send_member_signal();
    create trigger send_hide_signal after insert or delete on public.wake_hides
      for each row execute function private.send_hide_signal();
  end if;
end;
$$;
