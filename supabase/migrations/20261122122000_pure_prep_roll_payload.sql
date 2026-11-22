-- Preserve the pure-preparation source atomically for recurring occurrences.
-- Based on running roll_insert_occurrence function on 2026-11-20;
-- replace ONLY participant insert projection. Confirm main's latest RPC body
-- matches before deploying this migration.
-- Depends on 20261122120000 and 20261122121000.
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
    (appointment_id, user_id, origin_name, origin_lat, origin_lng, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes, prepare_value_source, outing_prep_minutes, outing_prep_source, outing_prep_model)
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
    p_participant ->> 'outing_prep_model'
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
