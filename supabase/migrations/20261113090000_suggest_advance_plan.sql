-- 알람 조정 제안 (ALG-07) 4단계 준비 — 당김 분을 알람 계산에 넣기 (안건 D111 · B안)
--   계산(plan-core · calc/chain.ts)은 이 PR의 서버 코드. 여기는 DB 쪽 두 가지
--
-- 1. 반복 일정의 새 회차가 당김 분을 이어받음 (D25 A "반복 회차 모두")
--    새 회차는 alarm-roll → roll_insert_occurrence가 참여 조건을 새로 넣는데, 그 함수는 정해진 칸만 써서 당김 분이 0으로 들어감
--    → 참여 조건을 넣을 때 당김 분이 0이면 같은 사람 · 같은 묶음의 바로 앞 회차 값을 이어받음 (큰 함수를 다시 쓰지 않고 트리거 하나로)
--    alarm-roll은 앞 회차 참여 조건(당김 분 포함)으로 알람을 계산하므로, 새 회차의 알람과 칸이 같은 당김을 가리킴
-- 2. 제안 재료(prepare_suggestion_inputs): 준비 알람을 직접 고른(MANUAL) 일정은 후보에서 뺌 — 계산이 그 시각을 안 바꾸므로 제안해도 적용할 수 없음

-- ---------------------------------------------------------------------
-- 1. 새 회차가 당김 분을 이어받음
-- ---------------------------------------------------------------------
create or replace function private.inherit_prepare_advance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_series uuid;
  v_at     timestamptz;
  v_adv    integer;
begin
  if coalesce(new.prepare_advance_minutes, 0) <> 0 then
    return new; -- 값을 정해서 넣은 줄은 그대로
  end if;
  select a.series_id, a.appointment_at into v_series, v_at
  from public.appointments a where a.appointment_id = new.appointment_id;
  if v_series is null then
    return new;
  end if;
  select p.prepare_advance_minutes into v_adv
  from public.appointment_participants p
  join public.appointments a on a.appointment_id = p.appointment_id
  where a.series_id = v_series and p.user_id = new.user_id and a.appointment_at < v_at
  order by a.appointment_at desc
  limit 1;
  new.prepare_advance_minutes := coalesce(v_adv, 0);
  return new;
end;
$$;

revoke execute on function private.inherit_prepare_advance() from public, anon, authenticated;

create trigger appointment_participants_inherit_prepare_advance
  before insert on public.appointment_participants
  for each row execute function private.inherit_prepare_advance();

-- ---------------------------------------------------------------------
-- 2. 제안 재료 — 직접 고른 준비 알람은 뺌 (나머지는 20261112090000과 같음)
-- ---------------------------------------------------------------------
create or replace function public.prepare_suggestion_inputs(p_now timestamptz default now())
returns table (
  user_id                uuid,
  participant_id         uuid,
  target_alarm_id        uuid,
  current_advance        integer,
  before_prepare_minutes integer,
  cap_minutes            integer,
  residuals              integer[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with targets as (
    select p.user_id, p.participant_id, a.series_id, p.prepare_advance_minutes,
           prep.alarm_id as prep_alarm_id, prep.scheduled_at as prep_at, wake.scheduled_at as wake_at
    from public.appointment_participants p
    join public.appointments a on a.appointment_id = p.appointment_id
    join public.alarms prep on prep.participant_id = p.participant_id and prep.alarm_type = 'PREPARE' and prep.is_enabled
    left join public.alarms wake on wake.participant_id = p.participant_id and wake.alarm_type = 'WAKE' and wake.is_enabled
    where a.series_id is not null
      and a.exception_kind is distinct from 'CANCELED'
      and a.appointment_at > p_now and a.appointment_at <= p_now + interval '36 hours'
      and prep.scheduled_at > p_now
      and prep.time_source is distinct from 'MANUAL' -- 준비 알람을 직접 고른 일정은 당기지 않음 (plan-core도 당김을 안 씀)
  ),
  series_suggestions as (
    -- 이 사람 · 이 묶음에 걸린 준비 알람 당김 제안
    select s.user_id, sa.series_id, s.status, s.created_at, s.responded_at
    from public.alarm_suggestions s
    join public.alarms al on al.alarm_id = s.target_alarm_id
    join public.appointment_participants sp on sp.participant_id = al.participant_id
    join public.appointments sa on sa.appointment_id = sp.appointment_id
    where s.suggestion_type = 'PREPARE_ADVANCE' and sa.series_id is not null
  ),
  open_targets as (
    select t.*,
           (select max(ss.responded_at) from series_suggestions ss
             where ss.user_id = t.user_id and ss.series_id = t.series_id and ss.status <> 'PENDING') as since
    from targets t
    where not exists (
      select 1 from series_suggestions ss
      where ss.user_id = t.user_id and ss.series_id = t.series_id
        and (ss.status = 'PENDING' or ss.created_at > p_now - interval '7 days')
    )
  ),
  history as (
    select t.participant_id as target_participant_id, ha.appointment_at,
           round(extract(epoch from (hp.departed_at - hp.prepare_started_at)) / 60.0)
             - round(extract(epoch from (dep.scheduled_at - hprep.scheduled_at)) / 60.0) as residual,
           row_number() over (partition by t.participant_id order by ha.appointment_at desc) as recent
    from open_targets t
    join public.appointments ha on ha.series_id = t.series_id and ha.appointment_at < p_now
    join public.appointment_participants hp on hp.appointment_id = ha.appointment_id and hp.user_id = t.user_id
    join public.alarms hprep on hprep.participant_id = hp.participant_id and hprep.alarm_type = 'PREPARE'
    join public.alarms dep on dep.participant_id = hp.participant_id and dep.alarm_type = 'DEPARTURE'
    where hp.prepare_started_at is not null and hp.departed_at is not null
      and (t.since is null or ha.appointment_at > t.since)
      and hp.departed_at - hp.prepare_started_at between interval '10 minutes' and interval '240 minutes'
      and abs(extract(epoch from (hp.departed_at - dep.scheduled_at))) > 180
  ),
  firsts as (
    select t.participant_id, min(fa.appointment_at) as first_at
    from open_targets t
    join public.appointments fa on fa.series_id = t.series_id
    join public.appointment_participants fp on fp.appointment_id = fa.appointment_id and fp.user_id = t.user_id
    group by t.participant_id
  )
  select t.user_id, t.participant_id, t.prep_alarm_id,
         t.prepare_advance_minutes,
         case when t.wake_at is null then null else round(extract(epoch from (t.prep_at - t.wake_at)) / 60.0)::integer end,
         case when f.first_at > p_now - interval '14 days' then 10 else 5 end,
         array_agg(h.residual::integer order by h.appointment_at)
  from open_targets t
  join history h on h.target_participant_id = t.participant_id and h.recent <= 10
  left join firsts f on f.participant_id = t.participant_id
  group by t.user_id, t.participant_id, t.prep_alarm_id, t.prepare_advance_minutes, t.prep_at, t.wake_at, f.first_at
  having count(*) >= 3
$$;

revoke execute on function public.prepare_suggestion_inputs(timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_suggestion_inputs(timestamptz) to service_role;
