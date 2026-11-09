-- 탐색 시험(Fable 계획 247개, S3 실행)에서 나온 서버 결함 (11/9)
--   X-WAKE-04  알람이 울린 뒤 알람만 끄고 기상 확인이 없으면 그룹 기상 조회에서 줄이 사라지고(약속이 다음 날 새벽이면 그룹 전체가 비고) 미확인 · 깨우기 대상에서도 빠짐
--              → 울린 기록이 있는 기상 알람은 꺼도 그날의 기준 알람으로 셈 (private.wake_alarm_counts). 울리기 전에 꺼 둔 알람은 그대로 '알람 없음'
--   X-PROP-01  늦추는 제안을 적용하면 같은 카드의 출발 알람이 같이 움직여 약속보다 뒤가 됨
--              → '새 출발 + 이동시간 > 약속 시각'이 되는 늦추기는 제안 보내기 · 적용 모두 TOO_LATE로 거절 (이동시간 값이 없으면 '새 출발 > 약속 시각'만)
--   X-PRIV-01  차단한 뒤에도 차단한 사람의 그룹 초대 카드가 받은 초대 목록에 남음
--              → 차단 쌍이 보낸 초대는 목록에서 빼고, 차단할 때 둘 사이의 대기 초대를 정리
--   X-APPT-01  만든 사람이 나간 공동 약속(creator_id 비어 있음)을 아무도 못 지움
--              → 그 약속에 참여한 그룹원이 지울 수 있게 (고치기 정책 appointments_update와 같은 조건: 참여 중인 그룹원 + 안 지난 약속)
--   X-APPT-04  그룹을 나가 참여자가 0명이 된 앞으로 약속이 아무도 못 고치는 채 남음
--              → 나가는 사람의 앞으로 약속 중 참여자가 한 명도 안 남은 것은 같이 지움
--   X-STATE-01 친구를 끊고 차단해도 차단 전에 받은 그룹 초대를 수락하면 들어가짐
--              → 차단한 사이가 보낸 초대는 수락할 수 없음(GONE) — 차단할 때 정리와 함께
--   X-SEED-03  일반 로그인 사용자도 개발용 초기화(dev_reset_my_data)로 자기 친구 · 그룹 데이터를 지울 수 있음
--              → 이메일이 @example.com인 시드 · 시험 계정만 허용 (일반 계정은 42501)
--   X-PRIV-09  알람 조회 권한이 있는 친구가 내가 참여한 공동 약속의 제목 · 장소를 그 그룹 멤버가 아니어도 봄
--              → 보는 사람이 그 그룹 멤버가 아니면 제목을 '그룹 일정', 장소를 빈 글자로 가림 (개인 일정은 그대로)
-- 함수 본문은 지난 마이그레이션(wake_status · wake_hardening · alarm_proposals · blocks · groups · account_delete · abuse_closing · group_wake)과 같고 위 이유로 달라진 곳에만 주석을 닮

-- ---------------------------------------------------------------------
-- 1. 기상 알람으로 셀 알람 — 켜져 있거나, 꺼졌어도 그날 울린 기록(TRIGGERED)이 있으면
-- ---------------------------------------------------------------------

-- 기록 구간은 그 알람 시각의 [6시간 전, 18시간 뒤) — 그룹 기상 조회와 미확인 후보가 같은 구간을 씀
create function private.wake_alarm_counts(p_alarm_id uuid, p_enabled boolean, p_scheduled_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_enabled, false) or exists (
    select 1
    from public.alarm_events e
    where e.alarm_id = p_alarm_id
      and e.event_type = 'TRIGGERED'
      and e.event_at >= p_scheduled_at - interval '6 hours'
      and e.event_at <  p_scheduled_at + interval '18 hours');
$$;
revoke execute on function private.wake_alarm_counts(uuid, boolean, timestamptz) from public, anon, authenticated;

-- 아래 네 함수는 `a.is_enabled` 한 곳만 위 함수로 바뀜
--   private.group_wake_has_meeting : 약속이 다음 날 새벽이어도 울린 기상 알람이 있으면 그날을 '약속 있는 날'로 셈
--   private.group_wake_rows        : 그날 기준 기상 알람 (꺼졌어도 울렸으면 울림 · 해제 · 미확인 단계가 그대로 보임)
--   public.find_missed_wake_alarms : 울린 뒤 꺼도 30분 지나 확인이 없으면 미확인(MISSED)으로 기록 → 본인 알림 · 친구 '깨워 볼까요?'
--   public.claim_wake_nudges       : 새벽 약속 판정에서 같은 규칙

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
             and ap.appointment_at >= (p_date::timestamp at time zone p_tz)
             and ap.appointment_at <  ((p_date + 1)::timestamp at time zone p_tz))
      or exists (
           select 1
           from public.appointments ap
           join public.appointment_participants pt on pt.appointment_id = ap.appointment_id
           join public.alarms a on a.participant_id = pt.participant_id and a.alarm_type = 'WAKE' and private.wake_alarm_counts(a.alarm_id, a.is_enabled, a.scheduled_at)
           join public.profiles pr on pr.user_id = a.user_id
           where ap.group_id = p_group_id
             and ap.appointment_at >= (p_date::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')) - interval '1 day'      -- 약속 이틀 전까지의 기상 알람만 셈(약속 시각 색인을 타게 좁힘)
             and ap.appointment_at <  ((p_date + 1)::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')) + interval '2 days'
             and a.scheduled_at >= (p_date::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul'))
             and a.scheduled_at <  ((p_date + 1)::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')));
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
  confirm_pending   boolean       -- 자동 판정 확인이 있는데 아직 20분이 안 지나 다른 사람에게 안 보이는 중 (8장 깨우기가 '이미 일어났어요'로 막을 때 씀)
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
         coalesce(c.pending, false)
  from members m
  join public.profiles pr on pr.user_id = m.user_id
  left join first_alarm f on f.user_id = m.user_id
  left join agg ag on ag.user_id = m.user_id
  left join conf c on c.user_id = m.user_id
  cross join lateral (
    select greatest(f.scheduled_at, coalesce(ag.last_snooze_end, f.scheduled_at)) + interval '30 minutes' as due_at
  ) due
  order by (m.user_id = p_viewer) desc, pr.nickname;
end;
$$;

create or replace function public.find_missed_wake_alarms(p_now timestamptz default now(), p_lookback_hours integer default 24)
returns table (
  alarm_id        uuid,
  user_id         uuid,
  participant_id  uuid,
  appointment_id  uuid,
  group_id        uuid,
  appointment_at  timestamptz,
  scheduled_at    timestamptz,
  intensity       public.alarm_intensity,
  snooze_minutes  integer,       -- 미루기 누적 합 (참고 값 — missed_at은 마지막 미루기 기준)
  missed_at       timestamptz,   -- 미확인 시각
  event_key       uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select a.alarm_id,
           a.user_id,
           a.participant_id,
           a.scheduled_at,
           a.intensity,
           coalesce(sn.total, 0)::integer as snooze_minutes,
           -- 마지막 울림 묶음이 시작한 때: 마지막 미루기의 다음 울림 (미루기가 없으면 알람 시각)
           greatest(a.scheduled_at, sn.last_ring_at) as last_ring_start,
           coalesce(pr.timezone, 'Asia/Seoul') as tz
    from public.alarms a
    join public.profiles pr on pr.user_id = a.user_id
    left join lateral (
      select sum(e.snooze_minutes) as total,
             (array_agg(e.event_at + make_interval(mins => coalesce(e.snooze_minutes, 0))
                        order by e.event_at desc, e.event_id desc))[1] as last_ring_at
      from public.alarm_events e
      where e.alarm_id = a.alarm_id
        and e.event_type = 'SNOOZED'
        and e.event_at >= a.scheduled_at - interval '6 hours'
        and e.event_at <  a.scheduled_at + interval '18 hours'
    ) sn on true
    where a.alarm_type = 'WAKE'
      and private.wake_alarm_counts(a.alarm_id, a.is_enabled, a.scheduled_at)
      and a.scheduled_at <= p_now - interval '30 minutes'
      and a.scheduled_at >  p_now - make_interval(hours => p_lookback_hours)
  ),
  due as (
    select b.*,
           b.last_ring_start + interval '30 minutes' as missed_at
    from base b
  )
  select d.alarm_id,
         d.user_id,
         d.participant_id,
         ap.appointment_id,
         ap.group_id,
         ap.appointment_at,
         d.scheduled_at,
         d.intensity,
         d.snooze_minutes,
         d.missed_at,
         md5('wake-missed:' || d.alarm_id::text || ':' || extract(epoch from d.scheduled_at)::bigint::text)::uuid
  from due d
  left join public.appointment_participants pt on pt.participant_id = d.participant_id
  left join public.appointments ap on ap.appointment_id = pt.appointment_id
  where d.missed_at <= p_now
    and not exists (
      select 1
      from public.alarm_events e
      where e.user_id = d.user_id
        and e.event_type = 'WAKE_CONFIRMED'
        and e.event_at >= d.scheduled_at - interval '2 days'
        and e.event_at <  d.scheduled_at + interval '2 days'
        and private.wake_day(e.alarm_id, e.event_at, d.tz) = (d.scheduled_at at time zone d.tz)::date)
    and not exists (
      select 1
      from public.alarm_events e
      where e.alarm_id = d.alarm_id
        and e.event_type = 'MISSED'
        and e.event_at >= d.scheduled_at - interval '6 hours')
    and not exists (
      select 1
      from public.daily_records dr
      where dr.user_id = d.user_id
        and dr.record_date = (d.scheduled_at at time zone d.tz)::date
        and dr.wake_confirmed_at is not null)
  order by d.missed_at, d.alarm_id;
$$;

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
                    join public.alarms al on al.participant_id = pt.participant_id and al.alarm_type = 'WAKE' and private.wake_alarm_counts(al.alarm_id, al.is_enabled, al.scheduled_at)
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


-- ---------------------------------------------------------------------
-- 2. 늦추는 제안이 약속에 늦게 만들면 거절 (TOO_LATE)
-- ---------------------------------------------------------------------

-- 상태가 하나 늘어남: propose_alarm_time · respond_alarm_proposal 모두 TOO_LATE (지난 정의는 20261109020300_friend_alarm_proposals.sql)
--   적용 쪽 TOO_LATE는 LIMIT · EXPIRED처럼 그 제안을 만료(EXPIRED)로 닫음 — 주인 카드에서 사라지고 보낸 쪽은 다시 제안할 수 있음
create or replace function public.propose_alarm_time(p_alarm_id uuid, p_new_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_alarm record;
  v_new   timestamptz;
  v_id    uuid;
  v_card  uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_alarm_id is null or p_new_at is null then
    return jsonb_build_object('status', 'INVALID');
  end if;

  select a.participant_id into v_card from public.alarms a where a.alarm_id = p_alarm_id;
  perform pg_advisory_xact_lock(hashtextextended('alarm_card:' || coalesce(v_card::text, p_alarm_id::text), 0));

  select a.user_id, a.scheduled_at, a.original_scheduled_at, a.is_enabled, a.participant_id into v_alarm
  from public.alarms a
  where a.alarm_id = p_alarm_id;

  if not found
     or v_alarm.user_id = v_uid
     or v_alarm.participant_id is null
     or not v_alarm.is_enabled
     or v_alarm.scheduled_at <= now()
     or v_alarm.user_id not in (select private.granted_owner_ids_for(v_uid, 'EDIT_ALARM')) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  v_new := date_trunc('minute', p_new_at);
  if v_new = date_trunc('minute', v_alarm.scheduled_at) then
    return jsonb_build_object('status', 'SAME');
  end if;
  if v_alarm.scheduled_at < now() + interval '10 minutes' or v_new < now() + interval '5 minutes' then
    return jsonb_build_object('status', 'TOO_SOON');
  end if;
  if abs(extract(epoch from (v_new - date_trunc('minute', coalesce(v_alarm.original_scheduled_at, v_alarm.scheduled_at))))) > 3600 then
    return jsonb_build_object('status', 'LIMIT');
  end if;
  -- 같은 카드의 안 울린 다른 알람이 같은 만큼 움직이면 지금 + 5분 이전이 되는가 (기상을 늦게 맞추려고 출발을 크게 당기는 경우)
  if exists (
    select 1 from public.alarms s
    where s.participant_id = v_alarm.participant_id and s.user_id = v_alarm.user_id and s.scheduled_at > now()
      and s.scheduled_at + (v_new - v_alarm.scheduled_at) < now() + interval '5 minutes') then
    return jsonb_build_object('status', 'TOO_SOON');
  end if;

  -- 늦추는 제안인데 같은 카드의 아직 안 울린 출발 알람이 같이 움직인 뒤 '출발 + 이동시간'이 약속 시각을 넘으면 거절 (탐색 시험 X-PROP-01)
  --   이동시간 값(est_travel_minutes)이 없으면 '새 출발 > 약속 시각'만. 앞당기는 제안은 이 검사를 안 함 (이미 늦은 알람을 당기는 길까지 막지 않게)
  if v_new > v_alarm.scheduled_at and exists (
    select 1
    from public.alarms d
    join public.appointment_participants pt on pt.participant_id = d.participant_id
    join public.appointments ap on ap.appointment_id = pt.appointment_id
    where d.participant_id = v_alarm.participant_id and d.user_id = v_alarm.user_id
      and d.alarm_type = 'DEPARTURE' and d.is_enabled and d.scheduled_at > now()
      and d.scheduled_at + (v_new - v_alarm.scheduled_at) + coalesce(pt.est_travel_minutes, 0) * interval '1 minute' > ap.appointment_at) then
    return jsonb_build_object('status', 'TOO_LATE');
  end if;

  update public.alarm_proposals
  set status = 'REPLACED', responded_at = now()
  where alarm_id = p_alarm_id and status = 'PENDING';

  insert into public.alarm_proposals (alarm_id, owner_id, proposer_id, from_at, to_at)
  values (p_alarm_id, v_alarm.user_id, v_uid, v_alarm.scheduled_at, v_new)
  returning proposal_id into v_id;

  return jsonb_build_object('status', 'OK', 'proposal_id', v_id, 'from_at', v_alarm.scheduled_at, 'to_at', v_new);
end;
$$;

create or replace function public.respond_alarm_proposal(p_proposal_id uuid, p_apply boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_p     record;
  v_a     record;
  v_ids   uuid[];
  v_card  uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_proposal_id is null or p_apply is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  -- 카드 단위 잠금을 제안 행 잠금보다 먼저 (제안 보내기와 같은 순서 — 같은 카드의 [적용] 둘이 서로 기다리지 않게)
  select a.participant_id into v_card
  from public.alarm_proposals p join public.alarms a on a.alarm_id = p.alarm_id
  where p.proposal_id = p_proposal_id and p.owner_id = v_uid;
  if found then
    perform pg_advisory_xact_lock(hashtextextended('alarm_card:' || coalesce(v_card::text, p_proposal_id::text), 0));
  end if;

  select p.proposal_id, p.alarm_id, p.proposer_id, p.from_at, p.to_at into v_p
  from public.alarm_proposals p
  where p.proposal_id = p_proposal_id and p.owner_id = v_uid and p.status = 'PENDING'
  for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if not p_apply then
    update public.alarm_proposals set status = 'DISMISSED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'DISMISSED');
  end if;

  select a.alarm_id, a.participant_id, a.scheduled_at, a.original_scheduled_at, a.is_enabled into v_a
  from public.alarms a
  where a.alarm_id = v_p.alarm_id and a.user_id = v_uid
  for update;

  if not found
     or not v_a.is_enabled
     or v_a.scheduled_at <> v_p.from_at
     or v_a.scheduled_at <= now()
     or v_p.to_at < now() + interval '5 minutes'
     or v_uid not in (select private.granted_owner_ids_for(v_p.proposer_id, 'EDIT_ALARM')) then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  if abs(extract(epoch from (v_p.to_at - date_trunc('minute', coalesce(v_a.original_scheduled_at, v_a.scheduled_at))))) > 3600 then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'LIMIT');
  end if;

  -- 같은 카드의 이른 알람이 이 만큼 움직이면 지금 + 5분 이전(과거)이 되는 경우는 적용하지 않음
  if exists (
    select 1 from public.alarms s
    where s.participant_id = v_a.participant_id and s.user_id = v_uid and s.scheduled_at > now()
      and s.scheduled_at + (v_p.to_at - v_p.from_at) < now() + interval '5 minutes') then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  -- 적용하면 같은 카드의 안 울린 출발 알람이 움직여 '출발 + 이동시간'이 약속 시각을 넘는 늦추기는 적용하지 않음 — 그사이 약속이나 이동시간이 바뀐 경우까지 (X-PROP-01)
  if v_p.to_at > v_p.from_at and exists (
    select 1
    from public.alarms d
    join public.appointment_participants pt on pt.participant_id = d.participant_id
    join public.appointments ap on ap.appointment_id = pt.appointment_id
    where d.participant_id = v_a.participant_id and d.user_id = v_uid
      and d.alarm_type = 'DEPARTURE' and d.is_enabled and d.scheduled_at > now()
      and d.scheduled_at + (v_p.to_at - v_p.from_at) + coalesce(pt.est_travel_minutes, 0) * interval '1 minute' > ap.appointment_at) then
    update public.alarm_proposals set status = 'EXPIRED', responded_at = now() where proposal_id = v_p.proposal_id;
    return jsonb_build_object('status', 'TOO_LATE');
  end if;

  perform set_config('app.alarm_apply', 'on', true);
  with moved as (
    update public.alarms a
    set scheduled_at          = a.scheduled_at + (v_p.to_at - v_p.from_at),
        -- 원래 시각으로 돌아오면 친구가 바꾸기 전 모습(시각 · time_source)으로, 아니면 친구가 정해 준 값이라 MANUAL
        time_source           = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then coalesce(a.original_time_source, a.time_source)
                                  else 'MANUAL'
                                end,
        original_scheduled_at = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then null
                                  else coalesce(a.original_scheduled_at, a.scheduled_at)
                                end,
        original_time_source  = case
                                  when a.scheduled_at + (v_p.to_at - v_p.from_at) = coalesce(a.original_scheduled_at, a.scheduled_at) then null
                                  else coalesce(a.original_time_source, a.time_source)
                                end
    where a.participant_id = v_a.participant_id
      and a.user_id = v_uid
      and a.scheduled_at > now()
    returning a.alarm_id
  )
  select array_agg(m.alarm_id order by m.alarm_id) into v_ids from moved m;
  perform set_config('app.alarm_apply', 'off', true);

  update public.alarm_proposals set status = 'APPLIED', responded_at = now() where proposal_id = v_p.proposal_id;
  update public.alarm_proposals ap
  set status = 'EXPIRED', responded_at = now()
  where ap.status = 'PENDING'
    and ap.alarm_id in (select a.alarm_id from public.alarms a where a.participant_id = v_a.participant_id);

  return jsonb_build_object('status', 'APPLIED', 'alarm_ids', to_jsonb(coalesce(v_ids, array[]::uuid[])));
end;
$$;


-- ---------------------------------------------------------------------
-- 3. 차단 쌍의 초대 (block_user · my_group_invites)
-- ---------------------------------------------------------------------

create or replace function public.block_user(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_new integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_user_id is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_user_id = v_uid then
    return jsonb_build_object('status', 'SELF');
  end if;

  -- 같은 두 사람의 요청 · 수락과 한 줄씩 (3장 쌍 잠금) — 맞요청 중에 차단해도 자동 수락이 안 되게 (4-08)
  perform private.lock_friend_pair(v_uid, p_user_id);

  if not exists (select 1 from public.profiles p where p.user_id = p_user_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, p_user_id) on conflict do nothing;
  get diagnostics v_new = row_count;

  -- 이미 차단한 사이여도 남은 것이 있으면 같이 정리함(멱등)
  delete from public.friends f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_user_id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user_id);
  delete from public.sharing_permissions sp
  where (sp.owner_id = v_uid and sp.grantee_id = p_user_id)
     or (sp.owner_id = p_user_id and sp.grantee_id = v_uid);
  -- 두 사람 사이에 대기 중인 그룹 초대(어느 쪽이 초대했든)도 정리함 — 차단한 사람의 초대 카드가 목록에 남지 않게 (탐색 시험 X-PRIV-01). 이미 들어간 그룹 자격은 그대로
  delete from public.group_members gm
  where gm.invite_status = 'INVITED'
    and ((gm.user_id = v_uid and gm.invited_by = p_user_id) or (gm.user_id = p_user_id and gm.invited_by = v_uid));

  return jsonb_build_object('status', case when v_new > 0 then 'BLOCKED' else 'ALREADY_BLOCKED' end);
end;
$$;

create or replace function public.my_group_invites()
returns table (group_id uuid, group_name text, member_count integer, invited_by uuid, invited_by_nickname varchar, invited_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.group_id, g.group_name, private.group_member_count(g.group_id), gm.invited_by, p.nickname, gm.invited_at
  from public.group_members gm
  join public.groups g on g.group_id = gm.group_id
  left join public.profiles p on p.user_id = gm.invited_by
  where gm.user_id = (select auth.uid()) and gm.invite_status = 'INVITED'
    and (gm.invited_by is null or not private.is_blocked_pair((select auth.uid()), gm.invited_by))   -- 차단 쌍이 보낸 초대는 안 보임 (X-PRIV-01)
  order by gm.invited_at desc nulls last, g.group_name;
$$;


-- ---------------------------------------------------------------------
-- 4. 만든 사람이 나간 공동 약속은 참여자가 지움
-- ---------------------------------------------------------------------

-- 지우기는 만든 사람만(그룹을 나간 만든 사람은 못 지움)이던 정책에, 만든 사람 칸이 빈 공동 약속을 참여 중인 그룹원이 지우는 길을 더함
--   조건은 고치기 정책(appointments_update)과 같음: 그 그룹에 참여 중 + 그 약속의 참여자 + 안 지난 약속(하루 경계) — 지난 약속의 기록은 안 지움
drop policy appointments_delete_creator on public.appointments;
create policy appointments_delete_creator on public.appointments
  for delete to authenticated
  using (
    (creator_id = (select auth.uid())
     and (group_id is null or private.is_group_member(group_id)))
    or (creator_id is null
        and group_id is not null
        and appointment_at >= private.day_start((select auth.uid()))
        and private.is_group_member(group_id)
        and private.is_appointment_participant(appointment_id)));


-- ---------------------------------------------------------------------
-- 5. 그룹을 나갈 때 참여자가 0명이 된 앞으로 약속은 지움 (X-APPT-04)
-- ---------------------------------------------------------------------

-- 지난 정의는 20261109031500_friend_account_delete.sql. 달라진 곳 = 참여가 지워진 약속을 모아 두었다가 참여자가 한 명도 안 남고 만든 사람 칸도 비었으면 약속을 지움 (지난 약속 · 만든 사람이 남은 약속 · 남의 할 일이 걸린 약속은 그대로)
create or replace function private.after_group_member_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_touched uuid[];
  v_locked  boolean;
begin
  -- 그룹 행을 먼저 잠가 둘이 동시에 나가도 나중 사람이 앞 사람의 나감(참여 삭제)을 보고 처리됨 — 아래 빈 약속 판정이 서로의 참여가 남아 보여 둘 다 못 지우는 일이 없게 (5-39 · X-APPT-04)
  perform 1 from public.groups g where g.group_id = old.group_id for update;
  v_locked := found;

  -- 이 사람의 참여가 지워지는 앞으로 약속 id를 모아 둠
  with gone as (
    delete from public.appointment_participants ap
    using public.appointments a
    where ap.appointment_id = a.appointment_id
      and a.group_id = old.group_id
      and a.appointment_at >= private.day_start(old.user_id)
      and ap.user_id = old.user_id
    returning ap.appointment_id)
  select coalesce(array_agg(g.appointment_id), '{}'::uuid[]) into v_touched from gone g;

  update public.appointments a
  set creator_id = null
  where a.group_id = old.group_id
    and a.creator_id = old.user_id
    and a.appointment_at >= private.day_start(old.user_id);

  -- 이 사람의 참여가 지워져 참여자가 한 명도 안 남았고 만든 사람 칸도 빈(이 사람이 만든 약속이거나 이미 비어 있던) 앞으로 약속은 지움 — 아무도 고치지 못하는 빈 약속을 남기지 않음 (탐색 시험 X-APPT-04).
  --   만든 사람이 그룹에 남아 있는 약속은 참여자가 없어도 그 사람이 고치거나 지울 수 있어 그대로 둠.
  --   남의 할 일(todos) · 고친 값 기록(user_edit_logs)이 가리키는 약속은 지우지 않음 (지우면 남의 행이 고쳐짐 — 개발용 초기화 시험의 "남의 행에 안 닿음"과 같은 방어)
  delete from public.appointments a
  where a.appointment_id = any(v_touched)
    and a.creator_id is null
    and not exists (select 1 from public.appointment_participants pt where pt.appointment_id = a.appointment_id)
    and not exists (select 1 from public.todos t where t.appointment_id = a.appointment_id and t.user_id <> old.user_id)
    and not exists (select 1 from public.user_edit_logs l where l.appointment_id = a.appointment_id and l.user_id <> old.user_id);

  if v_locked and not exists (
    select 1 from public.group_members gm where gm.group_id = old.group_id and gm.invite_status = 'JOINED'
  ) then
    delete from public.groups g where g.group_id = old.group_id;
  end if;
  return null;
end;
$$;

-- 계정 삭제 영향 요약(my_account_delete_summary · prepare_account_delete가 씀)의 "남을 공동 약속" 숫자에서 위 규칙으로 같이 지워지는 약속을 뺌. 지난 정의는 같은 파일
create or replace function private.account_delete_impact(p_user uuid)
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
          where a.creator_id = p_user and not m.disappears
            -- 나가면 같이 지워지는 약속(내가 혼자 참여한 앞으로 약속, 남의 할 일 · 고친 값 기록이 안 걸린 것)은 남지 않으므로 뺌 (after_group_member_gone, X-APPT-04)
            and not (
              a.appointment_at >= private.day_start(p_user)
              and exists (select 1 from public.appointment_participants pt where pt.appointment_id = a.appointment_id and pt.user_id = p_user)
              and not exists (select 1 from public.appointment_participants pt where pt.appointment_id = a.appointment_id and pt.user_id <> p_user)
              and not exists (select 1 from public.todos t where t.appointment_id = a.appointment_id and t.user_id <> p_user)
              and not exists (select 1 from public.user_edit_logs l where l.appointment_id = a.appointment_id and l.user_id <> p_user))),
         (select count(*)::integer from public.friends f
          where f.status = 'ACCEPTED' and p_user in (f.requester_id, f.addressee_id));
$$;


-- ---------------------------------------------------------------------
-- 6. 차단한 사이가 보낸 그룹 초대는 수락할 수 없음 (X-STATE-01)
-- ---------------------------------------------------------------------

create or replace function public.accept_group_invite(p_group_id uuid, p_wake_share boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_st  public.invite_status;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_group_id is null then
    return jsonb_build_object('status', 'GONE');
  end if;

  perform private.lock_group(p_group_id);
  perform private.lock_group_user(v_uid);

  -- 그룹 행을 키 공유로 잡음 — 마지막 멤버가 나가며 그룹을 지우는 일과 겹쳐도 수락이 성공으로 끝나지 않고 GONE (join_group과 같음)
  perform 1 from public.groups g where g.group_id = p_group_id for key share;
  if not found then
    return jsonb_build_object('status', 'GONE');
  end if;
  select gm.invite_status into v_st from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid;
  if v_st = 'JOINED' then
    return jsonb_build_object('status', 'ALREADY_JOINED', 'group_id', p_group_id);
  end if;
  if v_st is distinct from 'INVITED' then
    return jsonb_build_object('status', 'GONE');
  end if;
  -- 초대한 사람과 차단한 사이면 수락할 수 없음 — 차단 전에 받은 초대여도 (정리 전부터 남은 행 포함). 그 초대는 지우고 없는 초대와 같은 응답 (탐색 시험 X-STATE-01)
  if exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invited_by is not null
      and private.is_blocked_pair(v_uid, gm.invited_by)) then
    delete from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invite_status = 'INVITED';
    return jsonb_build_object('status', 'GONE');
  end if;
  if private.group_member_count(p_group_id) >= 20 then
    return jsonb_build_object('status', 'FULL');
  end if;
  if private.joined_group_count(v_uid) >= 10 then
    return jsonb_build_object('status', 'TOO_MANY_GROUPS');
  end if;

  update public.group_members gm
  set invite_status = 'JOINED', joined_at = now(), wake_share_opt_in = coalesce(p_wake_share, false),
      notifications_off = false, invited_by = null, invited_at = null
  where gm.group_id = p_group_id and gm.user_id = v_uid;
  return jsonb_build_object('status', 'JOINED', 'group_id', p_group_id);
end;
$$;


-- ---------------------------------------------------------------------
-- 7. 개발용 초기화는 시드 · 시험 계정만 (X-SEED-03)
-- ---------------------------------------------------------------------

-- 지난 정의는 20261109050000_friend_abuse_closing.sql. 달라진 곳 = 이메일 검사 하나. 앱의 개발 화면(/dev/screens)이 일반 계정으로 부르면 42501
create or replace function public.dev_reset_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_friend jsonb;
  v_email  text;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  -- 시드 · 시험 계정만: 이메일이 @example.com인 계정 (시드 데모 demo-… · 시험 도구 e2e-… · simfriend-… · 탐색 시험 probe… · DB 시험 계정이 모두 이 주소를 씀).
  --   카카오 · 구글로 들어온 일반 계정은 거절 (탐색 시험 X-SEED-03)
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email not like '%@example.com' then
    raise exception '시험 계정만 쓸 수 있음' using errcode = '42501';
  end if;
  v_friend := private.dev_reset_friend_data(v_uid);
  return private.dev_reset_my_data_core() || jsonb_build_object('friend_data', v_friend);
end;
$$;


-- ---------------------------------------------------------------------
-- 8. 알람 조회 권한으로 보는 약속 정보에서 남의 그룹 공동 약속은 가림 (X-PRIV-09)
-- ---------------------------------------------------------------------

-- 지난 정의는 20261015000100_group_wake.sql. 달라진 곳 = 보는 사람이 그 공동 약속의 그룹 멤버가 아니면 제목 '그룹 일정', 장소 빈 글자. 시각은 그대로, 개인 일정은 그대로
create or replace function public.get_shared_alarm_appointments(p_owner_id uuid default null)
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
         (case when ap.group_id is not null and not private.is_group_member(ap.group_id) then '그룹 일정' else ap.title end)::varchar,
         (case when ap.group_id is not null and not private.is_group_member(ap.group_id) then '' else ap.dest_name end)::varchar,
         ap.appointment_at
  from public.alarms a
  join public.appointment_participants pt on pt.participant_id = a.participant_id
  join public.appointments ap on ap.appointment_id = pt.appointment_id
  where a.user_id in (select private.granted_owner_ids('VIEW_ALARM'))
    and (p_owner_id is null or a.user_id = p_owner_id)
  order by ap.appointment_at, a.scheduled_at;
$$;
