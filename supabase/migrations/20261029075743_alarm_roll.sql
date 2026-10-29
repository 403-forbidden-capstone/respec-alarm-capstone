-- =====================================================================
-- 반복 다음 회차 ① 저장 모양 · 서버 함수가 쓰는 DB 부분 (L1 PR 3a-1, 이슈 #209 — 설계 메모 L1_PR3_설계메모.md 1절)
--   ① 묶음 칸           appointments · alarms에 series_id · occurrence_on — 회차마다 한 줄, 같은 묶음 + 같은 날짜는 한 줄뿐
--   ② 열쇠 칸           묶음 · 날짜는 한 번 정하면 못 바꿈 (keep_keys, service_role도)
--   ③ 앱 쓰기 제한      앱은 남의 묶음에 회차를 못 넣음 (appointments_insert)
--   ④ travel_source     길찾기 실패 폴백용 ESTIMATE 값 추가
--   ⑤ DB 함수           roll_insert_occurrence(회차 하나를 한 트랜잭션으로 씀) · roll_due_series(오늘 넘겨야 할 묶음 목록) — service_role 전용
--   ⑥ 재시도 기록 표    roll_attempts (service_role 전용)
--   ⑦ 예약              pg_cron이 5분마다 alarm-roll을 부름
-- 서버 함수 alarm-roll · 앱 맞추기는 다음 PR (3a-2 · 3b). 이 파일만 먼저 들어가도 지금 동작은 그대로임 — 모든 약속 · 일정 없는 알람이 묶음 1개짜리가 될 뿐
-- 하루 경계는 profiles.timezone(없으면 Asia/Seoul) 0시. 한국 · Android만, 앱 R02 기기 시간대와 같다고 봄(10/29 헤드)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. travel_source에 ESTIMATE — 회차 길찾기가 12시간 전까지 안 될 때의 근사값 (H03에서 "대략"으로 보임)
-- ---------------------------------------------------------------------
-- 같은 파일 안에서는 이 값을 쓰지 않음 (새 enum 값은 값을 추가한 트랜잭션이 끝나야 쓸 수 있음)

alter type public.travel_source add value if not exists 'ESTIMATE';


-- ---------------------------------------------------------------------
-- 1. 묶음 칸 — 모든 약속 · 일정 없는 알람이 묶음을 가짐 (반복이 아니면 1개짜리)
-- ---------------------------------------------------------------------
-- series_id     같은 반복의 회차들이 나눠 갖는 번호. 첫 회차는 자기 id (insert 전에 채움)
-- occurrence_on 그 회차의 날짜 = 만든 사람 시간대 기준 약속(알람) 날짜. 새벽 1시 약속은 UTC로는 전날이지만 한국 날짜로 셈
-- 반복을 나중에 켜도 열쇠 칸을 안 바꾸도록 처음부터 모두가 묶음을 가짐 (null → 값도 keep_keys가 막음)
-- 약속 · 루틴에 달린 알람은 series_id가 없음 — 약속이 묶음을 가지고, 루틴 알람은 같은 행의 시각만 옮김. 일정 없는 알람만 알람이 묶음을 가짐

alter table public.appointments
  add column series_id     uuid,
  add column occurrence_on date;

alter table public.alarms
  add column series_id     uuid,
  add column occurrence_on date;

alter table public.alarms
  add constraint alarms_series_standalone
  check (series_id is null or (participant_id is null and routine_id is null and occurrence_on is not null));

comment on column public.appointments.series_id     is '반복 묶음 번호 — 같은 반복의 회차(약속 행)들이 나눠 가짐. 첫 회차는 자기 appointment_id. 앱은 자기 id로만 넣을 수 있음(RLS), 한 번 정하면 못 바꿈(keep_keys)';
comment on column public.appointments.occurrence_on is '그 회차의 날짜 — 만든 사람 profiles.timezone(없으면 Asia/Seoul) 기준 appointment_at의 날짜. (creator_id, series_id, occurrence_on)이 유일 → 같은 회차를 두 번 안 만듦. 한 번 정하면 못 바꿈(이번만 시각을 바꿔도 날짜는 그대로)';
comment on column public.alarms.series_id           is '일정 없는 알람의 반복 묶음 번호 (약속 · 루틴 알람은 NULL). 첫 회차는 자기 alarm_id';
comment on column public.alarms.occurrence_on       is '일정 없는 알람의 회차 날짜 — 만든 사람 시간대 기준 scheduled_at의 날짜 (약속 · 루틴 알람은 NULL). (user_id, series_id, occurrence_on)이 유일';


-- ---------------------------------------------------------------------
-- 2. insert 전 채우기 — series_id가 없으면 자기 id, 날짜는 만든 사람 시간대의 약속(알람) 날짜
-- ---------------------------------------------------------------------
-- 알람 쪽은 일정 없는 알람(약속 · 루틴 둘 다 없음)만 채움. 약속 · 루틴 알람은 그대로 건너뜀
-- 서버 함수(alarm-commit)와 앱이 칸을 몰라도 되게 DB가 채움. alarm-roll은 두 칸을 직접 넣어 미리 정한 묶음에 회차를 넣음
-- 날짜는 만든 사람 시간대 기준 (profiles 행이 없으면 Asia/Seoul). 한국 · Android만, 앱 R02 기기 시간대와 같다고 봄(10/29 헤드)

create function private.fill_series()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tz text;
begin
  if tg_table_name = 'appointments' then
    new.series_id := coalesce(new.series_id, new.appointment_id);
    if new.occurrence_on is null then
      select p.timezone into v_tz from public.profiles p where p.user_id = new.creator_id;
      new.occurrence_on := (new.appointment_at at time zone coalesce(v_tz, 'Asia/Seoul'))::date;
    end if;
  elsif new.participant_id is null and new.routine_id is null then
    new.series_id := coalesce(new.series_id, new.alarm_id);
    if new.occurrence_on is null then
      select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
      new.occurrence_on := (new.scheduled_at at time zone coalesce(v_tz, 'Asia/Seoul'))::date;
    end if;
  end if;
  return new;
end;
$$;

create trigger fill_series before insert on public.appointments
  for each row execute function private.fill_series();
create trigger fill_series before insert on public.alarms
  for each row execute function private.fill_series();


-- ---------------------------------------------------------------------
-- 3. 지금 있는 행 채우기 → not null · 유니크
-- ---------------------------------------------------------------------
-- 채우는 update가 updated_at 트리거도 돌려 모든 행의 updated_at이 이 마이그레이션 시각으로 바뀜 — 앱은 appointments · alarms의 updated_at을 안 읽어서 영향 없음
-- keep_keys(아래 4절)는 이 채우기 뒤에 바꿈 (지금 keep_keys는 이 두 칸을 안 막음)

update public.appointments a
   set series_id     = a.appointment_id,
       occurrence_on = (a.appointment_at at time zone coalesce((select p.timezone from public.profiles p where p.user_id = a.creator_id), 'Asia/Seoul'))::date
 where a.series_id is null;

update public.alarms a
   set series_id     = a.alarm_id,
       occurrence_on = (a.scheduled_at at time zone coalesce((select p.timezone from public.profiles p where p.user_id = a.user_id), 'Asia/Seoul'))::date
 where a.series_id is null
   and a.participant_id is null
   and a.routine_id is null;

alter table public.appointments
  alter column series_id     set not null,
  alter column occurrence_on set not null;

-- 같은 회차를 두 번 만들지 않음. alarms는 약속 · 루틴 알람이 series_id NULL이라 서로 안 겹침
-- 부분 인덱스로 만들지 않은 이유: supabase-js upsert의 onConflict가 where 조건을 못 붙여서 부분 인덱스는 못 찾음 (alarm_supplement.sql의 client_event_id와 같음)
create unique index appointments_series_occurrence_key on public.appointments (creator_id, series_id, occurrence_on);
create unique index alarms_series_occurrence_key       on public.alarms (user_id, series_id, occurrence_on);


-- ---------------------------------------------------------------------
-- 4. 열쇠 칸에 묶음 · 날짜를 더함 — 지금 정의(rls.sql)와 같은 모양에 인자만 더함
-- ---------------------------------------------------------------------
-- 이번만 시각을 바꿔도 회차 날짜는 그대로 → alarm-roll이 같은 날을 다시 안 만듦. service_role도 못 바꿈 (null → 값도 막힘)

drop trigger keep_keys on public.appointments;
create trigger keep_keys before update on public.appointments
  for each row execute function private.prevent_key_change('creator_id', 'group_id', 'series_id', 'occurrence_on');

drop trigger keep_keys on public.alarms;
create trigger keep_keys before update on public.alarms
  for each row execute function private.prevent_key_change('user_id', 'participant_id', 'routine_id', 'series_id', 'occurrence_on');


-- ---------------------------------------------------------------------
-- 5. 앱은 남의 묶음에 회차를 못 넣음 — 앱이 넣는 약속은 늘 새 묶음(series_id = 자기 id)
-- ---------------------------------------------------------------------
-- 앱이 약속을 직접 넣는 곳은 지금 없음 (alarm-commit이 service_role로 넣음). 회차를 이어 붙이는 건 alarm-roll(service_role)뿐

alter policy appointments_insert on public.appointments
  with check (creator_id = (select auth.uid())
              and (group_id is null or private.is_group_member(group_id))
              and series_id = appointment_id);


-- ---------------------------------------------------------------------
-- 6. 재시도 기록 — 회차 길찾기가 실패한 날짜를 뒤로 미룸 (service_role 전용)
-- ---------------------------------------------------------------------
-- 날짜마다 한 줄. 실패하면 tries를 올리고 next_try_at(1 · 3 · 6시간 뒤)까지 그 묶음은 roll_due_series에서 빠짐.
-- skipped = 출발 시각까지 지나서 그 날짜를 건너뜀. 회차가 만들어지면 alarm-roll이 이 줄을 지움
-- RLS는 켜고 정책은 없음 → 앱(authenticated · anon)은 못 읽고 못 씀. service_role은 RLS를 안 탐

create table public.roll_attempts (
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  series_id     uuid not null,                         -- 논리 참조 (appointments.series_id / alarms.series_id)
  occurrence_on date not null,
  tries         integer not null default 0,
  next_try_at   timestamptz not null,
  last_error    varchar(40),                           -- TIMEOUT · HTTP · NO_ROUTE 같은 짧은 이름 (원문은 로그에만)
  skipped       boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (user_id, series_id, occurrence_on)
);

create trigger set_updated_at before update on public.roll_attempts
  for each row execute function public.set_updated_at();

comment on table public.roll_attempts is '반복 회차 만들기 재시도 기록 — 날짜마다 한 줄 (alarm-roll 전용, service_role만). 회차가 만들어지면 지움';
comment on column public.roll_attempts.next_try_at is '이 시각 전에는 그 묶음을 roll_due_series가 안 줌 (길찾기 실패 뒤 1 · 3 · 6시간)';
comment on column public.roll_attempts.skipped     is 'true = 출발 시각까지 지나서 그 날짜를 건너뜀 (다시 안 만듦)';

alter table public.roll_attempts enable row level security;

revoke all on public.roll_attempts from anon, authenticated;
grant select, insert, update, delete on public.roll_attempts to service_role;


-- ---------------------------------------------------------------------
-- 7. 회차 하나 쓰기 — 약속 · 참여 조건 · 알람 · 준비물을 한 트랜잭션으로 (alarm-roll이 부름)
-- ---------------------------------------------------------------------
-- 같은 (만든 사람, 묶음, 날짜)가 이미 있으면 아무것도 안 쓰고 null을 돌려줌 → 같은 요청을 두 번 보내도 같은 결과
-- 중간에 하나라도 실패하면 함수 전체가 되돌려짐 (alarm-commit은 트랜잭션이 아니라 직접 지움으로 되돌림)
-- 넣는 칸은 alarm-commit의 persistAppointment(_shared/commit.ts)가 넣는 칸과 같음. 더한 칸:
--   appointments  memo · dest_radius_m — 이어받기 표(메모 그대로)와 L2 장소 반경(#231)을 다음 회차에도 이어 가려고 (없으면 NULL)
-- p_appointment   { creator_id, series_id, occurrence_on, title, appointment_at, dest_name, dest_lat?, dest_lng?, dest_radius_m?, importance?, recurrence_rule?, memo?, group_id? }
-- p_participant   { origin_name?, origin_lat?, origin_lng?, transport_type?, est_travel_minutes?, travel_source?, prepare_minutes?, buffer_minutes? }
-- p_alarms        [{ alarm_type, scheduled_at, intensity?, voice_tone?, sound_key?, is_enabled?, time_source?, intensity_source?, last_calculated_at? }]
-- p_items         [{ title, due_date? }] — 준비물(todos ITEM). due_date가 없으면 회차 날짜. 제목은 100자까지, 빈 제목은 건너뜀
-- security definer: 부를 수 있는 건 service_role뿐이라 RLS를 거칠 이유가 없음 (batch_notify.sql의 함수들과 같음)

create function public.roll_insert_occurrence(p_appointment jsonb, p_participant jsonb, p_alarms jsonb, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator        uuid := (p_appointment ->> 'creator_id')::uuid;
  v_on             date := (p_appointment ->> 'occurrence_on')::date;
  v_appointment_id uuid;
  v_participant_id uuid;
begin
  if v_creator is null or (p_appointment ->> 'series_id') is null or v_on is null then
    raise exception 'creator_id · series_id · occurrence_on이 필요함' using errcode = '22023';
  end if;

  insert into public.appointments
    (creator_id, group_id, series_id, occurrence_on, title, appointment_at, dest_name, dest_lat, dest_lng, dest_radius_m, importance, recurrence_rule, memo)
  values (
    v_creator,
    (p_appointment ->> 'group_id')::uuid,
    (p_appointment ->> 'series_id')::uuid,
    v_on,
    p_appointment ->> 'title',
    (p_appointment ->> 'appointment_at')::timestamptz,
    p_appointment ->> 'dest_name',
    (p_appointment ->> 'dest_lat')::numeric,
    (p_appointment ->> 'dest_lng')::numeric,
    (p_appointment ->> 'dest_radius_m')::smallint,
    coalesce((p_appointment ->> 'importance')::public.importance_level, 'NORMAL'),
    p_appointment ->> 'recurrence_rule',
    p_appointment ->> 'memo'
  )
  on conflict (creator_id, series_id, occurrence_on) do nothing
  returning appointment_id into v_appointment_id;

  if v_appointment_id is null then
    return null;   -- 이미 있는 회차
  end if;

  insert into public.appointment_participants
    (appointment_id, user_id, origin_name, origin_lat, origin_lng, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes)
  values (
    v_appointment_id,
    v_creator,
    p_participant ->> 'origin_name',
    (p_participant ->> 'origin_lat')::numeric,
    (p_participant ->> 'origin_lng')::numeric,
    coalesce((p_participant ->> 'transport_type')::public.transport_type, 'TRANSIT'),
    (p_participant ->> 'est_travel_minutes')::integer,
    coalesce((p_participant ->> 'travel_source')::public.travel_source, 'API'),
    coalesce((p_participant ->> 'prepare_minutes')::integer, 60),
    coalesce((p_participant ->> 'buffer_minutes')::integer, 10)
  )
  returning participant_id into v_participant_id;

  insert into public.alarms
    (user_id, participant_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, is_enabled, time_source, intensity_source, last_calculated_at)
  select v_creator,
         v_participant_id,
         (e.a ->> 'alarm_type')::public.alarm_type,
         (e.a ->> 'scheduled_at')::timestamptz,
         coalesce((e.a ->> 'intensity')::public.alarm_intensity, 'NORMAL'),
         coalesce((e.a ->> 'voice_tone')::public.voice_tone, 'NEUTRAL'),
         e.a ->> 'sound_key',
         coalesce((e.a ->> 'is_enabled')::boolean, true),
         coalesce((e.a ->> 'time_source')::public.alarm_value_source, 'AUTO'),
         coalesce((e.a ->> 'intensity_source')::public.alarm_value_source, 'AUTO'),
         coalesce((e.a ->> 'last_calculated_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_alarms, '[]'::jsonb)) as e(a);

  insert into public.todos (user_id, appointment_id, title, todo_type, due_date)
  select v_creator,
         v_appointment_id,
         left(btrim(e.i ->> 'title'), 100),
         'ITEM',
         coalesce((e.i ->> 'due_date')::date, v_on)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(i)
  where nullif(btrim(e.i ->> 'title'), '') is not null;

  return v_appointment_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. 오늘 넘겨야 할 묶음 목록 — alarm-roll 배치가 5분마다 부름
-- ---------------------------------------------------------------------
-- 돌려주는 줄: (user_id, series_id, kind, template_id) — 가장 급한 순(아래 due_at)으로 p_limit개
--   APPOINTMENT  약속 묶음. series_id = 묶음 번호, template_id = 기준 회차(묶음에서 occurrence_on이 가장 늦은 약속)의 appointment_id
--                조건: 기준 회차에 recurrence_rule이 있고 개인 약속(group_id 없음 — 공동 약속 반복은 첫 회차만) · 기준 회차 약속 시각 < p_now + 14일(폰 맞추기 창과 같은 시각 기준)
--                      · 재시도 대기 아님(roll_attempts에 next_try_at이 아직 안 온 줄이 없음)
--                L6 안건후보: 재시도 도래 묶음 포함 기본안 — 가장 늦은 회차가 이미 14일 뒤여도, 길찾기 실패로 미뤄 둔 날짜(next_try_at이 지남)가 있으면 그 묶음도 줌
--                (가까운 회차만 실패하고 먼 회차는 만들어진 경우 그 빈 날짜가 영영 안 채워지는 일을 막음). 날짜가 어제 이전인 줄은 무시
--   STANDALONE   일정 없는 반복 알람. series_id = 묶음 번호, template_id = 기준 회차(가장 늦은 행)의 alarm_id. 조건: 기준 회차에 recurrence_rule · 시각 < p_now + 14일
--                L6 안건후보: 꺼 둔 반복 알람도 회차 유지 기본안 — 꺼진 채로도 줌 (새 회차가 꺼진 상태를 이어받음, 켜는 순간 다음 회차가 이미 있음)
--   ROUTINE      루틴. series_id = template_id = routine_id. 조건: 켜 둔 루틴(is_active) · 반복 요일이 있음 · 켜진 단계 알람 중 시각이 p_now 전인 것이 있음
--                루틴은 회차 행을 따로 만들지 않고 같은 알람 행의 시각만 다음 발생으로 옮김
-- p_now는 시험용(안 주면 지금)

create function public.roll_due_series(p_now timestamptz default now(), p_limit integer default 50)
returns table (
  user_id     uuid,
  series_id   uuid,
  kind        text,
  template_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with latest_appointment as (
    select distinct on (a.creator_id, a.series_id)
           a.creator_id, a.series_id, a.appointment_id, a.appointment_at, a.recurrence_rule, a.group_id
    from public.appointments a
    order by a.creator_id, a.series_id, a.occurrence_on desc, a.appointment_at desc, a.appointment_id
  ),
  latest_standalone as (
    select distinct on (al.user_id, al.series_id)
           al.user_id, al.series_id, al.alarm_id, al.scheduled_at, al.recurrence_rule
    from public.alarms al
    where al.series_id is not null   -- 일정 없는 알람만 series_id를 가짐
    order by al.user_id, al.series_id, al.occurrence_on desc, al.scheduled_at desc, al.alarm_id
  ),
  pending as (
    select ra.user_id,
           ra.series_id,
           bool_or(ra.next_try_at > p_now) as waiting,
           bool_or(ra.next_try_at <= p_now and ra.occurrence_on >= (p_now at time zone 'UTC')::date - 1) as retry_due
    from public.roll_attempts ra
    where not ra.skipped
    group by ra.user_id, ra.series_id
  ),
  due as (
    select a.creator_id as user_id,
           a.series_id,
           'APPOINTMENT'::text as kind,
           a.appointment_id as template_id,
           a.appointment_at as due_at
    from latest_appointment a
    left join pending pd on pd.user_id = a.creator_id and pd.series_id = a.series_id
    where a.recurrence_rule is not null
      and a.group_id is null
      and not coalesce(pd.waiting, false)
      and (a.appointment_at < p_now + interval '14 days' or coalesce(pd.retry_due, false))

    union all

    select s.user_id,
           s.series_id,
           'STANDALONE'::text,
           s.alarm_id,
           s.scheduled_at
    from latest_standalone s
    where s.recurrence_rule is not null
      and s.scheduled_at < p_now + interval '14 days'

    union all

    select r.user_id,
           r.routine_id,
           'ROUTINE'::text,
           r.routine_id,
           min(al.scheduled_at)
    from public.routines r
    join public.alarms al on al.routine_id = r.routine_id
    where r.is_active
      and nullif(btrim(r.repeat_days), '') is not null
      and al.is_enabled
      and al.scheduled_at < p_now
    group by r.user_id, r.routine_id
  )
  select d.user_id, d.series_id, d.kind, d.template_id
  from due d
  order by d.due_at, d.user_id, d.series_id
  limit p_limit;
$$;


-- ---------------------------------------------------------------------
-- 실행 권한 — 서버 함수(service_role)만. 앱(authenticated · anon)은 못 부름
-- ---------------------------------------------------------------------
-- fill_series는 트리거 함수라 실행 권한이 없어도 트리거로는 돎

revoke execute on function private.fill_series() from public, anon, authenticated;
revoke execute on function public.roll_insert_occurrence(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.roll_due_series(timestamptz, integer) from public, anon, authenticated;

grant execute on function public.roll_insert_occurrence(jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.roll_due_series(timestamptz, integer) to service_role;


-- ---------------------------------------------------------------------
-- 9. 예약 — pg_cron이 5분마다 alarm-roll을 부름 (batch_notify.sql의 wake-check와 같은 모양)
-- ---------------------------------------------------------------------
-- alarm-roll 함수 배포는 앱 맞추기 PR(3b) 머지 뒤 — 그 전엔 호출이 404로 끝남 (private.invoke_edge_function은 pg_net 요청만 보내므로 해롭지 않음)
-- pg_cron 확장은 batch_notify.sql이 만듦. 없는 곳(PGlite 같은 검사용 DB)에서는 예약을 건너뜀. 같은 이름으로 다시 예약하면 기존 작업을 갈아끼움

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('alarm-roll', '*/5 * * * *', $cmd$select private.invoke_edge_function('alarm-roll')$cmd$);
  end if;
end;
$$;
