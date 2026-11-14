-- 알람 조정 제안 (ALG-07) 3단계 — 저녁에 제안 만들기 (#49 · 안건 D111)
--   매일 18:00(KST) pg_cron → suggestion-generate(Edge, 서비스 키). 그 함수가 아래 prepare_suggestion_inputs로 재료를 읽고
--   규칙(supabase/functions/_shared/calc/suggest.ts, #464)을 돌려 alarm_suggestions에 PREPARE_ADVANCE · PENDING을 넣음
--   18:00인 이유: 아침 출발이 다 기록된 뒤, 저녁 자기 전 대화(D111 5번)보다 앞서 카드가 준비되게 (작성자 판단 — 레포 문서의 03:00 대신)
--   묻는 쪽(저녁 대화 카드 · 그룹 탭 카드 · S01)과 적용(알람 계산 반영)은 다음 PR — 지금은 앱이 PREPARE_ADVANCE를 숨김(#484)
--
-- 1. 같은 준비 알람에 대기 중인 준비 알람 당김 제안은 하나만 (배치가 두 번 돌아도 한 줄)
-- 2. prepare_suggestion_inputs(p_now) — 제안 후보와 근거 잔차. 서버 역할만 (roll_due_series와 같음)
--    후보: 지금 ~ 36시간 안의 반복 일정(series_id 있음, 이번만 지운 회차 아님)에 켜진 준비 알람이 아직 안 울린 참여 조건
--      · 같은 묶음에 대기 중인 준비 알람 당김 제안이 있거나, 7일 안에 만든 제안이 있으면 뺌 (D62 주 단위 상한)
--    근거: 같은 사람 · 같은 묶음의 지난 회차 중 준비 시작(prepare_started_at) · 출발(departed_at)이 다 있는 회차
--      · 실제 준비 = 출발 − 준비 시작, 계획 준비 = 출발 알람 − 준비 알람 (울린 알람 시각이라 이미 적용한 당김이 들어 있음 — 두 번 반영 안 됨)
--      · 잔차 = 실제 − 계획 (분, 반올림). 실제 준비가 10 ~ 240분 밖이면 뺌 (prepare.ts와 같은 범위)
--      · 예정 출발(출발 알람) ±3분에 나간 날은 뺌 (D62 — 기다렸다 나갔을 수 있어 늘리는 근거가 못 됨)
--      · 이 묶음의 마지막 응답한 제안(적용 · 고쳐 적용 · 무시)보다 뒤의 회차만 (D24 C 무시 뒤 실측 3번 · D62 효과 볼 때까지)
--      · 최근 10개, 오래된 → 최근 순서. 3개 미만이면 후보에서 뺌
--    상한(cap_minutes): 이 묶음의 첫 회차가 14일 안이면 10분, 아니면 5분 (D62 — 처음 2주 하루 ±10분, 그 뒤 주 ±5분)
--    준비 전 시간(before_prepare_minutes): 켜진 기상 알람이 있으면 준비 알람 − 기상 알람(분), 없으면 null(기상을 당길 일 없음)

-- ---------------------------------------------------------------------
-- 1. 대기 중 제안 하나만
-- ---------------------------------------------------------------------
create unique index if not exists alarm_suggestions_one_pending_prepare_advance
  on public.alarm_suggestions (target_alarm_id)
  where status = 'PENDING' and suggestion_type = 'PREPARE_ADVANCE';

-- ---------------------------------------------------------------------
-- 2. 제안 후보 · 근거 잔차
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

-- ---------------------------------------------------------------------
-- 3. 매일 18:00 KST = 09:00 UTC
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('suggestion-generate', '0 9 * * *', $cmd$select private.invoke_edge_function('suggestion-generate')$cmd$);
  end if;
end;
$$;
