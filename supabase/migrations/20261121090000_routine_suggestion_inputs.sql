-- 루틴 제안 (안건 D114) 3단계 — 18:00 배치의 재료. suggestion-generate가 알람 조정 제안 다음에 부름
--   routine_suggestion_inputs(p_now, p_days) — 사람마다 최근 p_days일의 아침 기록 한 줄씩. 규칙(calc/routine.ts morningCause)이 쓰는 칸 그대로
--     날짜 · 요일: 그 사람 시간대(profiles.timezone, 없으면 Asia/Seoul)의 그날 — 요일은 0 일 ~ 6 토
--     기상 알람: 그날 켜진 기상 알람 중 가장 이른 것 (지금보다 앞의 것만). 기상 알람이 없는 날은 줄이 없음(기록이 없는 아침)
--     기상 확인: 그날 하루 기록의 기상 확인 시각, 없으면 그 알람 6시간 전 ~ 18시간 뒤의 기상 확인 기록 (7장 기록 구간과 같음)
--     기상 미확인: 그 기상 알람에 미확인(MISSED) 기록이 있음
--     준비 알람 · 준비 시작: 그날 가장 이른 준비 알람과 그 참여 조건의 준비 시작(#490)
--     준비물: 그날 마감인 준비물(todo_type ITEM) 수, 그중 안 챙겼거나 그날 0시 뒤에 챙긴 수(전날 밤에 못 챙김)
--   서버 역할만 (prepare_suggestion_inputs와 같음)

create or replace function public.routine_suggestion_inputs(p_now timestamptz default now(), p_days integer default 21)
returns table (
  user_id            uuid,
  record_date        date,
  weekday            integer,
  wake_alarm_at      timestamptz,
  wake_confirmed_at  timestamptz,
  wake_missed        boolean,
  prepare_alarm_at   timestamptz,
  prepare_started_at timestamptz,
  items_due          integer,
  items_late         integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with wake as (
    select a.user_id, a.alarm_id, a.scheduled_at,
           coalesce(nullif(p.timezone, ''), 'Asia/Seoul') as tz,
           (a.scheduled_at at time zone coalesce(nullif(p.timezone, ''), 'Asia/Seoul'))::date as d
    from public.alarms a
    join public.profiles p on p.user_id = a.user_id
    where a.alarm_type = 'WAKE' and a.is_enabled
      and a.scheduled_at < p_now
      and a.scheduled_at >= p_now - make_interval(days => p_days)
  ),
  first_wake as (
    select distinct on (w.user_id, w.d) w.user_id, w.d, w.tz, w.alarm_id, w.scheduled_at
    from wake w
    order by w.user_id, w.d, w.scheduled_at
  )
  select f.user_id,
         f.d,
         extract(dow from f.d)::integer,
         f.scheduled_at,
         coalesce(
           dr.wake_confirmed_at,
           (select min(e.event_at) from public.alarm_events e
             where e.user_id = f.user_id and e.event_type = 'WAKE_CONFIRMED'
               and e.event_at >= f.scheduled_at - interval '6 hours' and e.event_at < f.scheduled_at + interval '18 hours')
         ),
         exists (select 1 from public.alarm_events e where e.alarm_id = f.alarm_id and e.event_type = 'MISSED'),
         prep.scheduled_at,
         ap.prepare_started_at,
         coalesce(items.due, 0),
         coalesce(items.late, 0)
  from first_wake f
  left join public.daily_records dr on dr.user_id = f.user_id and dr.record_date = f.d
  left join lateral (
    select pa.scheduled_at, pa.participant_id
    from public.alarms pa
    where pa.user_id = f.user_id and pa.alarm_type = 'PREPARE' and pa.is_enabled
      and (pa.scheduled_at at time zone f.tz)::date = f.d
    order by pa.scheduled_at
    limit 1
  ) prep on true
  left join public.appointment_participants ap on ap.participant_id = prep.participant_id
  left join lateral (
    select count(*)::integer as due,
           count(*) filter (where t.done_at is null or t.done_at >= (f.d::timestamp at time zone f.tz))::integer as late
    from public.todos t
    where t.user_id = f.user_id and t.todo_type = 'ITEM' and t.due_date = f.d
  ) items on true
  order by f.user_id, f.d
$$;

revoke execute on function public.routine_suggestion_inputs(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.routine_suggestion_inputs(timestamptz, integer) to service_role;
