-- =====================================================================
-- 알람 강도 축별 고르기 ① 진동 칸 (이슈 #312, 결정 D1 A + D69)
--   ① 새 칸        alarms.vibration — 진동만 따로 고른 값. NULL = 강도(intensity)를 따름
--   ② DB 함수      roll_insert_occurrence — 반복 다음 회차가 직전 회차의 직접 고른 진동도 이어받음 (alarms insert에 vibration 한 줄)
-- 서버 함수 · 앱은 이 파일 밖. 이 파일만 먼저 들어가도 지금 동작은 그대로 (모든 행의 vibration이 NULL = 강도를 따름 → 기존 알람의 진동은 그대로)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 진동 칸
-- ---------------------------------------------------------------------
-- 알람 강도는 세 축으로 나뉨 (D1 A):
--   · intensity   = "전체 세기" — 볼륨 · 다시 울림 횟수. 자동 단계(약 · 보통 · 강)가 그대로 들어감
--   · sound_key   = 배경음 축 · voice_tone = 말소리 축 (둘은 전과 같음)
--   · vibration   = 진동 축. 직접 고른 값만 들어가고, 자동이면 NULL → 앱 · 폰이 intensity에서 풀어 씀 (약 NONE · 보통 SHORT_REPEAT · 강 STRONG_CONTINUOUS)
-- 예전에는 진동 축 단계가 intensity 칸에 들어갔음. 기존 행은 그대로 두고(백필 없음) vibration이 NULL이라 intensity를 따름 —
--   예전에 진동만 직접 올린 알람은 intensity가 그 단계라 진동은 그대로이고, 다음에 서버가 다시 계산해 저장할 때 전체 세기만 자동 값으로 돌아감
-- text + check로 둔 이유: 값을 더할 때 enum 타입 변경(트랜잭션 제약) 없이 check만 바꾸면 됨 (appointments.exception_kind와 같은 방식)
-- L6 안건후보: 진동 칸 이름 · 값 기본안 = alarms.vibration ('NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS', NULL = 강도를 따름), 알람 코어 vibration 칸 값 이름과 같음

alter table public.alarms
  add column if not exists vibration text
  constraint alarms_vibration_check check (vibration in ('NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS'));

comment on column public.alarms.vibration is '진동 축을 직접 고른 값 — NULL 강도(intensity)를 따름 · NONE 진동 없음 · SHORT_REPEAT 짧게 반복 · STRONG_CONTINUOUS 강하게 연속. intensity는 전체 세기(볼륨 · 다시 울림)이고 진동은 이 칸이 있으면 이 칸이 우선';



-- ---------------------------------------------------------------------
-- 2. roll_insert_occurrence — 진동 이어받기
-- ---------------------------------------------------------------------
-- 20261029075743_alarm_roll.sql의 함수와 같고, 알람 insert의 vibration 한 줄만 다름 (create or replace — 이전 파일은 그대로 둠)
-- p_alarms        [{ alarm_type, scheduled_at, intensity?, voice_tone?, sound_key?, vibration?, is_enabled?, time_source?, intensity_source?, last_calculated_at? }]
--   vibration이 없거나 null이면 NULL(강도를 따름), 'NONE' · 'SHORT_REPEAT' · 'STRONG_CONTINUOUS' 밖이면 check가 거절

create or replace function public.roll_insert_occurrence(p_appointment jsonb, p_participant jsonb, p_alarms jsonb, p_items jsonb)
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
    (user_id, participant_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, time_source, intensity_source, last_calculated_at)
  select v_creator,
         v_participant_id,
         (e.a ->> 'alarm_type')::public.alarm_type,
         (e.a ->> 'scheduled_at')::timestamptz,
         coalesce((e.a ->> 'intensity')::public.alarm_intensity, 'NORMAL'),
         coalesce((e.a ->> 'voice_tone')::public.voice_tone, 'NEUTRAL'),
         e.a ->> 'sound_key',
         e.a ->> 'vibration',
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


-- 실행 권한 — 이전 정의와 같음 (service_role만. create or replace는 권한을 그대로 두지만 이 파일만 읽어도 알 수 있게 다시 적음)
revoke execute on function public.roll_insert_occurrence(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.roll_insert_occurrence(jsonb, jsonb, jsonb, jsonb) to service_role;
