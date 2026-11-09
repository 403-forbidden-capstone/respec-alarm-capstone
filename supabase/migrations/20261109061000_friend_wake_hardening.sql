-- =====================================================================
-- 친구 7 · 8장 보정 — 기상 조회 날짜 제한 · 20분 동안의 깨우기 응답 · '깨워 볼까요?' 대상. 이슈 #431
--   ① 기상 조회(get_group_wake · get_group_wake_status)의 날짜는 호출자 시간대 기준 어제 · 오늘 · 내일만 — 그 밖이면 줄 없음.
--      날짜를 바꿔 가며 친구의 지난 기상 이력(알람 시각 · 확인 시각)을 거슬러 읽는 길을 막음 (11/9 헤드·S1 제안)
--   ② 자동 판정 기상이 20분 동안 친구에게 안 보이는 중에 깨우기를 누르면 '이미 일어났어요'(ALREADY_UP) 대신 '지금은 깨울 수 없어요'(OFF)로 —
--      숨기던 확인이 깨우기 응답으로 먼저 드러나지 않게 (D61 · 7-d7, 11/9 헤드 결정). 앱은 OFF를 이미 그 문구로 보여 줌
--   ③ '깨워 볼까요?'(NUDGE) 친구 알림은 깨우기 받기를 끈 사람(wake_ping_enabled = false)에 대해서는 정하지 않음 — 깨울 수 없는 사람을 깨우라고 하지 않음
--   함수 본문은 앞 마이그레이션의 것을 한 곳(표시한 줄)만 바꿔 다시 정의함
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 기상 조회 날짜 범위
-- ---------------------------------------------------------------------

-- p_date가 비었으면 통과(= 오늘). 아니면 호출자(로그인한 사람) 시간대의 오늘과 하루 이내. 시간대가 없으면 서울
create function private.wake_date_in_range(p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_date is null
      or abs(p_date - ((now() at time zone coalesce((select p.timezone from public.profiles p where p.user_id = (select auth.uid())), 'Asia/Seoul'))::date)) <= 1;
$$;

revoke execute on function private.wake_date_in_range(date) from public, anon, authenticated;

create or replace function public.get_group_wake(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,
  wake_confirmed_at timestamptz,
  wake_status       text          -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM (앱이 아직 · 울렸어요 · 일어남 · 알람 없음으로 묶음)
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at, r.wake_confirmed_at, r.wake_status
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

create or replace function public.get_group_wake_status(p_group_id uuid, p_date date default null)
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
  wake_status       text           -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
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
         r.wake_status
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r
  where private.wake_date_in_range(p_date);
$$;

-- ---------------------------------------------------------------------
-- 2. 20분 동안의 깨우기 응답
-- ---------------------------------------------------------------------

create or replace function private.wake_ping_verdict(p_sender uuid, p_target uuid, p_now timestamptz, p_group_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz        text;
  v_enabled   boolean;
  v_date      date;
  v_day_start timestamptz;
  v_day_end   timestamptz;
  v_row       record;
  v_count     integer;
  v_last      timestamptz;
  v_gid       uuid;
begin
  if p_sender is null or p_target is null or p_sender = p_target then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  select coalesce(pr.timezone, 'Asia/Seoul'), pr.wake_ping_enabled into v_tz, v_enabled
  from public.profiles pr
  where pr.user_id = p_target;
  if not found then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  v_date      := (p_now at time zone v_tz)::date;
  v_day_start := v_date::timestamp at time zone v_tz;
  v_day_end   := (v_date + 1)::timestamp at time zone v_tz;

  select r.wake_alarm_at, r.wake_status, r.confirm_pending, gs.group_id into v_row
  from public.group_members gs
  cross join lateral private.group_wake_rows(p_sender, gs.group_id, v_date, p_now) r
  where gs.user_id = p_sender and gs.invite_status = 'JOINED'
    and (p_group_id is null or gs.group_id = p_group_id)
    and r.user_id = p_target
  order by gs.group_id
  limit 1;
  if not found then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;
  v_gid := v_row.group_id;

  if not v_enabled then
    return jsonb_build_object('status', 'OFF', 'group_id', v_gid);
  end if;
  if v_row.wake_status = 'CONFIRMED' then
    return jsonb_build_object('status', 'ALREADY_UP', 'group_id', v_gid);
  end if;
  -- 자동 판정(폰 사용) 확인이 있는데 아직 20분이 안 지나 친구 화면에는 안 보이는 중(D61, 7-d7): '이미 일어났어요'로 답하면 숨기던 확인이 먼저 드러나므로
  --   다른 거절(받기 끔)과 같은 OFF — 앱은 이미 OFF를 '지금은 깨울 수 없어요'로 보여 줌
  if v_row.confirm_pending then
    return jsonb_build_object('status', 'OFF', 'group_id', v_gid);
  end if;
  if v_row.wake_alarm_at is null or v_row.wake_alarm_at > p_now then
    return jsonb_build_object('status', 'NOT_RINGING', 'group_id', v_gid);
  end if;

  select count(*)::integer, max(ps.sent_at) into v_count, v_last
  from public.push_sends ps
  where ps.kind = 'WAKE_PING' and ps.sender_id = p_sender and ps.target_id = p_target
    and ps.sent_at >= v_day_start and ps.sent_at < v_day_end;

  if v_count >= 3 then
    return jsonb_build_object('status', 'DAILY_LIMIT', 'group_id', v_gid, 'resets_at', v_day_end);
  end if;
  if v_last is not null and v_last + interval '5 minutes' > p_now then
    return jsonb_build_object('status', 'WAIT', 'group_id', v_gid, 'next_at', v_last + interval '5 minutes');
  end if;
  return jsonb_build_object('status', 'OK', 'group_id', v_gid, 'count', v_count);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. '깨워 볼까요?' 대상에서 받기 끈 사람 빼기
-- ---------------------------------------------------------------------

create or replace function public.claim_wake_nudges(p_now timestamptz default now())
returns table (event_key text, kind text, recipient_id uuid, sleeper_id uuid, group_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with cand as (
    select e.user_id as sleeper_id,
           coalesce(pr.timezone, 'Asia/Seoul') as tz,
           private.wake_day(e.alarm_id, e.event_at, coalesce(pr.timezone, 'Asia/Seoul')) as d,
           min(e.event_at) as missed_at
    from public.alarm_events e
    join public.alarms a on a.alarm_id = e.alarm_id and a.alarm_type = 'WAKE'
    join public.profiles pr on pr.user_id = e.user_id
    where e.event_type = 'MISSED'
      and pr.wake_ping_enabled                                                  -- 깨우기 받기를 끈 사람은 깨우라고 하지 않음 (8-카, 11/9 헤드 결정)
      and e.event_at <= p_now - interval '10 minutes'
      and e.event_at >  p_now - interval '12 hours'
    group by e.user_id, coalesce(pr.timezone, 'Asia/Seoul'), private.wake_day(e.alarm_id, e.event_at, coalesce(pr.timezone, 'Asia/Seoul'))
  ),
  still_asleep as (
    select c.* from cand c
    where not exists (
      select 1 from public.alarm_events w
      where w.user_id = c.sleeper_id and w.event_type = 'WAKE_CONFIRMED'
        and w.event_at <= p_now and w.event_at >= c.missed_at - interval '1 day'
        and coalesce(w.input_source::text, '') not in ('MANUAL', 'VOICE')
        and private.wake_day(w.alarm_id, w.event_at, c.tz) = c.d)
  ),
  want as (
    select distinct on (s.sleeper_id, s.d, gm.user_id) s.sleeper_id, s.d, gm.user_id as recipient_id, gs.group_id
    from still_asleep s
    join public.group_members gs on gs.user_id = s.sleeper_id and gs.invite_status = 'JOINED' and gs.wake_share_opt_in
    join public.group_members gm on gm.group_id = gs.group_id and gm.invite_status = 'JOINED'
                                and gm.user_id <> s.sleeper_id and not gm.notifications_off
    where private.can_see_wake(gm.user_id, s.sleeper_id, gs.group_id)
      and (select min(ap.appointment_at)
           from public.appointments ap
           where ap.group_id = gs.group_id
             and ap.appointment_at >= (s.d::timestamp at time zone s.tz)
             and (ap.appointment_at < ((s.d + 1)::timestamp at time zone s.tz)
                  or exists (                                                              -- 새벽 약속: 그 사람의 기상 알람이 그날 울리는 다음 날 약속도 그날 약속 (7장 group_wake_has_meeting과 같음)
                    select 1
                    from public.appointment_participants pt
                    join public.alarms al on al.participant_id = pt.participant_id and al.alarm_type = 'WAKE' and al.is_enabled
                    where pt.appointment_id = ap.appointment_id and pt.user_id = s.sleeper_id
                      and al.scheduled_at >= (s.d::timestamp at time zone s.tz)
                      and al.scheduled_at <  ((s.d + 1)::timestamp at time zone s.tz)))) > p_now
    order by s.sleeper_id, s.d, gm.user_id, gs.group_id
  ),
  ins as (
    insert into public.push_sends (kind, target_id, subject_id, day, sent_at)
    select 'NUDGE', w.recipient_id, w.sleeper_id, w.d, p_now from want w
    on conflict (kind, target_id, subject_id, day) where kind in ('NUDGE', 'UP') do nothing
    returning target_id, subject_id, day
  )
  select 'NUDGE:' || i.subject_id::text || ':' || i.day::text || ':' || i.target_id::text, 'NUDGE'::text, i.target_id, i.subject_id, w.group_id
  from ins i
  join want w on w.recipient_id = i.target_id and w.sleeper_id = i.subject_id and w.d = i.day;

  return query
  with later_up as (
    select n.target_id, n.subject_id, n.day, g.group_id
    from public.push_sends n
    join public.profiles pr on pr.user_id = n.subject_id
    cross join lateral (
      select gs.group_id
      from public.group_members gs
      join public.group_members gm on gm.group_id = gs.group_id and gm.invite_status = 'JOINED' and gm.user_id = n.target_id and not gm.notifications_off
      where gs.user_id = n.subject_id and gs.invite_status = 'JOINED'
        and private.can_see_wake(gm.user_id, gs.user_id, gs.group_id)
      order by gs.group_id
      limit 1) g
    where n.kind = 'NUDGE'
      and n.sent_at > p_now - interval '12 hours'
      and not exists (select 1 from public.push_sends u
                      where u.kind = 'UP' and u.target_id = n.target_id and u.subject_id = n.subject_id and u.day = n.day)
      and exists (
        select 1 from public.alarm_events w
        where w.user_id = n.subject_id and w.event_type = 'WAKE_CONFIRMED'
          and w.event_at <= p_now and w.event_at >= n.sent_at - interval '1 day'
          and coalesce(w.input_source::text, '') not in ('MANUAL', 'VOICE')
          and (w.input_source is distinct from 'USAGE' or w.event_at <= p_now - interval '20 minutes')
          and private.wake_day(w.alarm_id, w.event_at, coalesce(pr.timezone, 'Asia/Seoul')) = n.day)
  ),
  ins as (
    insert into public.push_sends (kind, target_id, subject_id, day, sent_at)
    select 'UP', u.target_id, u.subject_id, u.day, p_now from later_up u
    on conflict (kind, target_id, subject_id, day) where kind in ('NUDGE', 'UP') do nothing
    returning target_id, subject_id, day
  )
  select 'UP:' || i.subject_id::text || ':' || i.day::text || ':' || i.target_id::text, 'UP'::text, i.target_id, i.subject_id, u.group_id
  from ins i
  join later_up u on u.target_id = i.target_id and u.subject_id = i.subject_id and u.day = i.day;
end;
$$;
