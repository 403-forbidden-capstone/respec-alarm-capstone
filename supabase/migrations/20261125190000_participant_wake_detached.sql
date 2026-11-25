-- 따로 울리는 기상 표시 (#624)
-- 자동으로는 기상이 없는 일정(그날 앞 일정에 기상 · 계산된 기상이 낮 12시 이후)에 사용자가 기상 시각을 직접 골라 켠 경우,
-- 그 기상은 따로 울리고 준비 · 출발은 기상 없는 계산 그대로 둔다. 알람 행(기상 MANUAL + 준비 AUTO)만으로는
-- "준비가 기상을 따라가는 일정의 옮긴 기상"과 구별할 수 없어(준비 전 활동만큼 옮기면 행이 똑같음) 참여 행에 표시를 둔다.
-- 서버 계획(plan-core computePlan)이 정하고 alarm-commit · appointment-edit · alarm-roll이 저장, 앱 H03이 읽음.
alter table public.appointment_participants
  add column if not exists wake_detached boolean not null default false;
comment on column public.appointment_participants.wake_detached is
  '따로 울리는 기상(#624): true면 이 참여의 기상 알람은 직접 고른 시각에 따로 울리고 준비 알람은 기상을 따라가지 않음 (기상 − 준비 간격은 준비 전 활동이 아님)';

-- 반복 회차도 표시를 이어받음 — 20261122122000_pure_prep_roll_payload.sql의 함수에서 참여 insert에 wake_detached만 더함
CREATE OR REPLACE FUNCTION public.roll_insert_occurrence(p_appointment jsonb, p_participant jsonb, p_alarms jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    (appointment_id, user_id, origin_name, origin_lat, origin_lng, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes, prepare_value_source, outing_prep_minutes, outing_prep_source, outing_prep_model, wake_detached)
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
    coalesce((p_participant ->> 'buffer_minutes')::integer, 10),
    coalesce(p_participant ->> 'prepare_value_source', 'LEGACY'),
    (p_participant ->> 'outing_prep_minutes')::integer,
    p_participant ->> 'outing_prep_source',
    p_participant ->> 'outing_prep_model',
    coalesce((p_participant ->> 'wake_detached')::boolean, false)
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
$function$
;
revoke execute on function public.roll_insert_occurrence(jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.roll_insert_occurrence(jsonb,jsonb,jsonb,jsonb) to service_role;
