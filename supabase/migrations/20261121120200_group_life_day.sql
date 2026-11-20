-- 그룹 화면의 하루 = 새벽 4시 기준일 (11/20 지형님 결정, 앱 mobile/src/lib/format.ts lifeDayKey · AI 대화와 같은 규칙, KST)
--   · 기준일 D의 창 = D 04:00 ~ 다음 날 04:00 (그 사람 시간대). 23:30 · 00:30 약속은 둘 다 같은 하루, 03:30 기상 · 05:00 약속은 같은 약속 줄, 평범한 07:00 기상 · 10:00 약속은 그대로
--   · private.group_wake_rows: p_date가 없으면 (지금 − 4시간)의 날짜. 약속 있는 날 판단(group_wake_has_meeting) · 약속 고르기(출발 · 도착)도 이 창
--   · 기상 알람은 '그 약속에 딸린 알람'으로 찾음 — 이 그룹의 그 창 약속에 참여한 사람의 기상 알람이 있으면 그것, 없으면 그 창 안 첫 기상 알람.
--     기상 기록(울림 · 미루기 · 해제 · 미확인 · 확정)은 기록 날짜(wake_day)가 아니라 고른 알람의 alarm_id로 묶음 (자정 · 4시를 걸쳐도 같은 줄)
--   · 새로 고침 신호의 날짜도 같은 기준일 (send_wake_signal · send_trip_signal · send_appointment_signal · group_signal_date · 기상 정정 신호)
--   · 범위 밖: daily_records · 하루 기록 날짜(private.wake_day)는 그대로(달력 날짜), 깨우기(plan_wake_ping) 판정도 그대로

create function private.life_day(p_ts timestamptz, p_tz text)
returns date
language sql
immutable
set search_path = ''
as $$
  select ((p_ts at time zone coalesce(p_tz, 'Asia/Seoul')) - interval '4 hours')::date;
$$;

revoke execute on function private.life_day(timestamptz, text) from public, anon, authenticated;

-- 신호에 실을 날짜: 그 기상 알람이 이 그룹의 약속에 딸려 있으면 그 약속의 기준일, 아니면 알람이 울린 시각(알람 시각 6시간 전 ~ 18시간 뒤 안이면 알람 시각, 아니면 기록 시각)의 기준일
create function private.wake_signal_date(p_alarm_id uuid, p_event_at timestamptz, p_tz text, p_group_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.life_day(coalesce(
           (select ap.appointment_at
            from public.alarms a
            join public.appointment_participants pt on pt.participant_id = a.participant_id
            join public.appointments ap on ap.appointment_id = pt.appointment_id
            where a.alarm_id = p_alarm_id and ap.group_id = p_group_id),
           (select a.scheduled_at
            from public.alarms a
            where a.alarm_id = p_alarm_id and a.alarm_type = 'WAKE'
              and p_event_at >= a.scheduled_at - interval '6 hours'
              and p_event_at <  a.scheduled_at + interval '18 hours'),
           p_event_at), p_tz);
$$;

revoke execute on function private.wake_signal_date(uuid, timestamptz, text, uuid) from public, anon, authenticated;

-- 그 기준일에 이 그룹 '약속 있는 날'인가 — 그 그룹 약속이 기준일 창(D 04:00 ~ D+1 04:00)에 있을 때
create or replace function private.group_wake_has_meeting(p_group_id uuid, p_date date, p_tz text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.appointments ap
           where ap.group_id = p_group_id
             and ap.appointment_at >= ((p_date::timestamp + interval '4 hours') at time zone p_tz)
             and ap.appointment_at <  (((p_date + 1)::timestamp + interval '4 hours') at time zone p_tz));
$$;

-- 앱이 날짜를 넘길 수 있는 범위(기준일 어제 · 오늘 · 내일)도 기준일로 — 친구의 지난 기상을 거슬러 읽는 길 막기(friend_wake_hardening)와 같은 규칙, '오늘'만 새벽 4시 기준
create or replace function private.wake_date_in_range(p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_date is null or p_date between t.today - 1 and t.today + 1
  from (select private.life_day(now(), (select p.timezone from public.profiles p where p.user_id = (select auth.uid()))) as today) t;
$$;

create or replace function private.group_wake_rows(p_viewer uuid, p_group_id uuid, p_date date default null, p_now timestamptz default now())
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
  v_date := coalesce(p_date, private.life_day(p_now, v_tz)); -- 그룹 화면의 하루 = 새벽 4시 기준일 (11/20 지형님, AI 대화의 lifeDayKey와 같은 규칙)

  if not private.group_wake_has_meeting(p_group_id, v_date, v_tz) then
    return;
  end if;

  return query
  with members as (
    select gm.user_id,
           gm.trip_share_opt_in                                                       as trip_opt,
           coalesce(pr.timezone, 'Asia/Seoul')                                         as tz,
           ((v_date::timestamp + interval '4 hours') at time zone coalesce(pr.timezone, 'Asia/Seoul'))       as w_from,
           (((v_date + 1)::timestamp + interval '4 hours') at time zone coalesce(pr.timezone, 'Asia/Seoul')) as w_to
    from public.group_members gm
    join public.profiles pr on pr.user_id = gm.user_id
    where gm.group_id = p_group_id
      and gm.invite_status = 'JOINED'
      and (gm.user_id = p_viewer or private.can_see_wake(p_viewer, gm.user_id, p_group_id))
  ),
  -- 기상 알람 = '그 약속에 딸린 알람': 이 그룹의 그 기준일 창 약속에 참여한 사람의 켜진(또는 울린) 기상 알람, 없으면 그 창 안 그 사람의 첫 기상 알람.
  --   (새벽 3:30 기상 · 5:00 약속처럼 알람이 창 앞(4시 전)에 있어도 약속에 딸려 있으면 그 약속 줄에 붙음)
  appt_alarm as (
    select distinct on (m.user_id) m.user_id, a.alarm_id, a.scheduled_at
    from members m
    join public.appointment_participants pt on pt.user_id = m.user_id
    join public.appointments ap on ap.appointment_id = pt.appointment_id
      and ap.group_id = p_group_id
      and ap.appointment_at >= m.w_from
      and ap.appointment_at <  m.w_to
    join public.alarms a on a.participant_id = pt.participant_id
      and a.alarm_type = 'WAKE'
      and private.wake_alarm_counts(a.alarm_id, a.is_enabled, a.scheduled_at)
    order by m.user_id, a.scheduled_at, a.alarm_id
  ),
  window_alarm as (
    select distinct on (a.user_id) a.user_id, a.alarm_id, a.scheduled_at
    from public.alarms a
    join members m on m.user_id = a.user_id
    where a.alarm_type = 'WAKE'
      and private.wake_alarm_counts(a.alarm_id, a.is_enabled, a.scheduled_at)
      and a.scheduled_at >= m.w_from
      and a.scheduled_at <  m.w_to
    order by a.user_id, a.scheduled_at, a.alarm_id
  ),
  first_alarm as (
    select m.user_id, coalesce(pa.alarm_id, wa.alarm_id) as alarm_id, coalesce(pa.scheduled_at, wa.scheduled_at) as scheduled_at
    from members m
    left join appt_alarm pa on pa.user_id = m.user_id
    left join window_alarm wa on wa.user_id = m.user_id
    where coalesce(pa.alarm_id, wa.alarm_id) is not null
  ),
  -- 기상 기록(울림 · 미루기 · 해제 · 미확인)은 고른 알람의 alarm_id로 묶음 (기록 날짜가 아니라)
  ev as (
    select f.user_id, true as is_first, e.event_type, e.event_at, e.snooze_minutes
    from first_alarm f
    join public.alarm_events e on e.alarm_id = f.alarm_id
      and e.event_type in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED')
      and e.event_at >= f.scheduled_at - interval '6 hours'
      and e.event_at <  f.scheduled_at + interval '18 hours'
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
      and e.alarm_id = f.alarm_id
      and e.event_at >= f.scheduled_at - interval '6 hours'
      and e.event_at <  f.scheduled_at + interval '18 hours'
      and coalesce(e.input_source::text, '') not in ('MANUAL', 'VOICE')
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

create or replace function private.group_signal_date(p_group_id uuid, p_tz text)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.group_wake_has_meeting(p_group_id, private.life_day(now(), p_tz), coalesce(p_tz, 'Asia/Seoul'))
      then private.life_day(now(), p_tz)
    else (select private.life_day(ap.appointment_at, p_tz)
          from public.appointments ap
          where ap.group_id = p_group_id
          order by abs(extract(epoch from (ap.appointment_at - now()))), ap.appointment_id
          limit 1)
  end;
$$;

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
  v_date := private.life_day(v_appt, v_tz);

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

create or replace function private.send_appointment_signal()
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
      perform private.send_group_refresh(old.group_id, private.life_day(old.appointment_at, v_tz));
      return old;
    end if;
    perform private.send_group_refresh(new.group_id, private.life_day(new.appointment_at, v_tz));
    if private.life_day(old.appointment_at, v_tz) <> private.life_day(new.appointment_at, v_tz) then
      perform private.send_group_refresh(new.group_id, private.life_day(old.appointment_at, v_tz));   -- 날짜가 바뀌면 옛 날짜 화면도 비워야 함
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;

create or replace function private.send_wake_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz       text;
  v_alarm_at timestamptz;
  v_date     date;
  v_group    uuid;
begin
  if new.event_type not in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED', 'WAKE_CONFIRMED') then
    return null;
  end if;
  if new.input_source in ('MANUAL', 'VOICE', 'USAGE') then
    return null;
  end if;

  select a.scheduled_at into v_alarm_at
  from public.alarms a
  where a.alarm_id = new.alarm_id and a.alarm_type = 'WAKE';
  -- 울림 · 미루기 · 해제 · 미확인은 기상 알람 것만 (기상 확인은 알람 종류를 안 봄)
  if new.event_type <> 'WAKE_CONFIRMED' and v_alarm_at is null then
    return null;
  end if;

  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');

  for v_group in
    select gm.group_id
    from public.group_members gm
    where gm.user_id = new.user_id
      and gm.invite_status = 'JOINED'
      and gm.wake_share_opt_in      -- D19 결정 전 보수 기본값
  loop
    v_date := private.wake_signal_date(new.alarm_id, new.event_at, v_tz, v_group);
    if not private.group_wake_has_meeting(v_group, v_date, v_tz) then
      continue;
    end if;
    begin
      perform realtime.send(jsonb_build_object('date', v_date), 'refresh', 'group:' || v_group || ':wake', true);
    exception when others then
      raise warning '기상 신호를 보내지 못함 (group %): %', v_group, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

create or replace function private.apply_wake_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_conf  record;
  v_date  date;
  v_group uuid;
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz := coalesce(v_tz, 'Asia/Seoul');

  for v_conf in
    delete from public.alarm_events e
    where e.user_id = new.user_id
      and e.alarm_id = new.alarm_id
      and e.event_type = 'WAKE_CONFIRMED'
      and e.event_at <= new.event_at
      and e.event_at >  new.event_at - interval '1 day' -- 막는 쪽(③)과 같은 1일 창: 알람 행이 다음 회차로 재사용돼도 며칠 전 확정은 안 지움
    returning e.event_at, e.alarm_id
  loop
    v_date := private.wake_day(v_conf.alarm_id, v_conf.event_at, v_tz);
    update public.daily_records d
       set wake_confirmed_at = null, updated_at = now()
     where d.user_id = new.user_id and d.record_date = v_date and d.wake_confirmed_at = v_conf.event_at;
  end loop;

  -- 친구 화면 새로 고침 — 지울 확정이 없었어도(이미 앱이 지움) 보냄. 날짜는 그룹 화면의 기준일(새벽 4시 기준, 그 알람이 붙은 그룹 약속의 날)
  for v_group in
    select gm.group_id
    from public.group_members gm
    where gm.user_id = new.user_id
      and gm.invite_status = 'JOINED'
      and gm.wake_share_opt_in
  loop
    v_date := private.wake_signal_date(new.alarm_id, new.event_at, v_tz, v_group);
    if private.group_wake_has_meeting(v_group, v_date, v_tz) then
      perform private.send_group_refresh(v_group, v_date);
    end if;
  end loop;

  return null;
end;
$$;
