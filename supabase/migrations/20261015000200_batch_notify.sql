-- =====================================================================
-- DB 보완 ③ 배치 · 서버 함수가 쓰는 판정 (10/15 작업 계획 P3 — 전체작업계획_v1.md 8절)
--   ⑦ 배치 (Q5 A)        pg_cron이 5분마다 pg_net으로 서버 함수 wake-check를 부름. 주소 · 키는 Supabase Vault
--   ⑧ 푸시 보내도 되는지  can_send_push()  notify 서버 함수가 보내기 전에 부름 (service_role 전용)
--   ⑨ 기상 미확인 후보    find_missed_wake_alarms()  wake-check 서버 함수가 MISSED로 기록할 알람을 찾음 (service_role 전용)
-- 아래 함수들은 서버 함수(service_role)만 실행함. 앱(authenticated · anon)은 못 부름
-- =====================================================================


-- ---------------------------------------------------------------------
-- ⑦ 배치 — pg_cron → pg_net → 서버 함수 (Q5 A)
-- ---------------------------------------------------------------------
-- 서버 함수를 부르는 곳: 프로젝트 주소(project_url)와 service_role 키(service_role_key)를 Vault에서 읽어 POST함
--   Vault 비밀값 이름 두 개는 관리자가 나중에 만듦 (supabase/README.md "배치 키"). 없거나 Vault · pg_net이 없는 곳이면
--   오류 없이 경고만 남기고 끝남 → 배치가 5분마다 돌아도 아무 일이 없음 (실패해도 무해)
create function private.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  -- 이름은 경로에 그대로 붙으므로 함수 이름 모양(소문자 · 숫자 · -)만 받음. 아니면 아래 exception에서 경고 + null
  if p_name !~ '^[a-z0-9-]+$' then
    raise exception '서버 함수 이름 모양이 아님: %', p_name;
  end if;

  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'project_url';
  select ds.decrypted_secret into v_key from vault.decrypted_secrets ds where ds.name = 'service_role_key';

  if v_url is null or v_key is null then
    raise warning '서버 함수 %를 부르지 못함: Vault에 project_url · service_role_key가 없음', p_name;
    return null;
  end if;

  return net.http_post(
    url                  := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    body                 := p_body,
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'Authorization', 'Bearer ' || v_key,
                                               'apikey', v_key),
    timeout_milliseconds := 10000
  );
exception when others then
  raise warning '서버 함수 % 호출 실패: %', p_name, sqlerrm;
  return null;
end;
$$;

-- 확장과 예약은 있는 곳에서만: PGlite 같은 검사용 DB에는 pg_cron · pg_net이 없어 건너뜀 (supabase/tests가 cron 흉내로 예약 부분을 검사함)
-- 같은 이름으로 다시 예약하면 pg_cron이 기존 작업을 갈아끼움
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;

  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('wake-check', '*/5 * * * *', $cmd$select private.invoke_edge_function('wake-check')$cmd$);
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- ⑧ 푸시를 보내도 되는지 — notify 서버 함수의 권한 확인
-- ---------------------------------------------------------------------
-- 판정 함수 private.granted_owner_ids(kind)는 부른 사람(auth.uid())을 받는 쪽으로 보지만, 서버 함수(service_role)는
-- auth.uid()가 없음 → 받는 쪽을 직접 넘기는 버전을 만들고, 기존 함수는 그걸 부르게 해서 판정을 한 군데에 둠 (7장 7.10)
create function private.granted_owner_ids_for(p_grantee_id uuid, p_kind text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.owner_id
  from public.sharing_permissions sp
  where sp.grantee_id = p_grantee_id
    and case p_kind
          when 'VIEW_ALARM' then sp.can_view_alarm
          when 'EDIT_ALARM' then sp.can_edit_alarm
          when 'VIEW_WAKE'  then sp.can_view_wake
          else false
        end
    and private.is_valid_permission_source(sp.owner_id, sp.grantee_id, sp.source_type, sp.source_id)
    and (p_kind <> 'VIEW_WAKE'
         or sp.source_type = 'FRIEND'
         or exists (
              select 1
              from public.group_members gm
              where gm.group_id = sp.source_id
                and gm.user_id = sp.owner_id
                and gm.wake_share_opt_in));
$$;

create or replace function private.granted_owner_ids(p_kind text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.granted_owner_ids_for((select auth.uid()), p_kind);
$$;

-- 푸시 종류별 보내도 되는지. 보내는 사람(sender) → 받는 사람(target)
--   ALARM_CHANGED  G04: 보내는 사람이 받는 사람의 알람에 설정 권한(EDIT_ALARM, 친구 ∪ 그룹)을 가짐
--                  (알람을 실제로 고치려면 RLS상 조회 권한도 필요함 — 푸시는 설정 권한만 봄)
--   WAKE_PING      G03 깨우기: 조건이 D19(그룹 기상 조회를 켤 때 기상 공유 동의도 켤지) 결정 뒤에 정해짐 → 그 전에는 모두 거절
--                  (간격 제한은 D51 뒤)
--   그 밖의 종류는 거절
create function public.can_send_push(p_sender_id uuid, p_target_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'ALARM_CHANGED' then coalesce(
      p_target_id in (select private.granted_owner_ids_for(p_sender_id, 'EDIT_ALARM')),
      false)
    -- when 'WAKE_PING' then ... D19 결정 뒤
    else false
  end;
$$;


-- ---------------------------------------------------------------------
-- ⑨ 기상 미확인(MISSED) 후보 — wake-check가 5분마다 부름
-- ---------------------------------------------------------------------
-- 7장 7.9.2: 미확인 시각 = 알람 시각 + 안 끄면 다시 울림 총 소요(7.4.2) + 미루기 누적 + 30분
--   같은 알람에 WAKE_CONFIRMED · MISSED가 없으면 MISSED로 기록. 끄지 않았거나 폰이 꺼져 있어도 판정함 (TRIGGERED 여부와 무관)
--   다시 울림 총 소요 (alarm-core.md #29 · 7장 7.4.2): 첫 울림이 시작한 때부터 마지막 울림이 끝날 때까지. 울림은 1회 최대 3분이고,
--     다시 울림 간격은 알람 코어와 같게 "울림이 끝난 뒤 쉬는 시간"으로 읽음 (지형님께 확인 중 — 바뀌면 아래 case 한 곳만 고침)
--     약(SOFT)    울림 3 + 쉼 5 + 울림 3                     = 11분
--     보통(NORMAL) 울림 3 + 쉼 5 + 울림 3 + 쉼 5 + 울림 3     = 19분
--     강(STRONG)  울림 3 × 4 + 쉼 3 × 3                       = 21분
--     (작성자 판단) 문서는 "5분 후 1회" · "3분 간격 3회"의 간격을 시작 기준으로 읽을 수도 있음(5 · 10 · 9분) — 30분 여유 안의 차이
--   미루기 누적 = 그 알람의 SNOOZED 기록 snooze_minutes 합. 확인 알림에 응답이 없을 때의 재울림 항은 D2 결정 뒤에 더함 (지금은 0)
-- 어느 회차의 기록인지(작성자 판단): 알람 시각 6시간 전부터의 기록만 봄 — 알람 행을 다음 회차로 재사용해도(D4 열림) 전날 기록을 안 섞음
--   daily_records.wake_confirmed_at도 같은 구간이면 확인한 것으로 봄 (get_group_wake_status가 이벤트가 없으면 쓰는 값과 같게 — 그룹판과 푸시가 다르지 않게)
-- 판정 대상(작성자 판단): 켜져 있는 기상 알람, 알람 시각이 p_lookback_hours(기본 24시간) 안. 오래된 알람이 한꺼번에 MISSED로 쏟아지지 않게
-- p_now는 시험용(안 주면 지금)
-- event_key: 이 알람의 MISSED 기록을 서버가 두 번 넣지 않도록 alarm_events.client_event_id에 쓰는 고정 번호 (같은 알람 · 같은 알람 시각이면 같은 값)
-- 돌려주는 appointment_* · group_id: 공동 약속 지연 알림(7.9.4)용. 약속이 없는 알람이면 비어 있음
create function public.find_missed_wake_alarms(p_now timestamptz default now(), p_lookback_hours integer default 24)
returns table (
  alarm_id        uuid,
  user_id         uuid,
  participant_id  uuid,
  appointment_id  uuid,
  group_id        uuid,
  appointment_at  timestamptz,
  scheduled_at    timestamptz,
  intensity       public.alarm_intensity,
  rering_minutes  integer,       -- 안 끄면 다시 울림 총 소요 (첫 울림 시작 ~ 마지막 울림 끝)
  snooze_minutes  integer,       -- 미루기 누적
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
           case a.intensity when 'SOFT' then 11 when 'NORMAL' then 19 else 21 end as rering_minutes,
           coalesce((select sum(e.snooze_minutes)
                     from public.alarm_events e
                     where e.alarm_id = a.alarm_id
                       and e.event_type = 'SNOOZED'
                       and e.event_at >= a.scheduled_at - interval '6 hours'), 0)::integer as snooze_minutes
    from public.alarms a
    where a.alarm_type = 'WAKE'
      and a.is_enabled
      and a.scheduled_at <= p_now - interval '30 minutes'
      and a.scheduled_at >  p_now - make_interval(hours => p_lookback_hours)
  ),
  due as (
    select b.*,
           b.scheduled_at + make_interval(mins => b.rering_minutes + b.snooze_minutes + 30) as missed_at
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
         d.rering_minutes,
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
      where e.alarm_id = d.alarm_id
        and e.event_type in ('WAKE_CONFIRMED', 'MISSED')
        and e.event_at >= d.scheduled_at - interval '6 hours')
    and not exists (
      select 1
      from public.daily_records dr
      where dr.user_id = d.user_id
        and dr.wake_confirmed_at >= d.scheduled_at - interval '6 hours')
  order by d.missed_at, d.alarm_id;
$$;


-- ---------------------------------------------------------------------
-- 실행 권한 — 서버 함수(service_role)만
-- ---------------------------------------------------------------------

revoke execute on function private.invoke_edge_function(text, jsonb) from public, anon, authenticated;
revoke execute on function private.granted_owner_ids_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.can_send_push(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.find_missed_wake_alarms(timestamptz, integer) from public, anon, authenticated;

grant execute on function private.invoke_edge_function(text, jsonb) to service_role;
grant execute on function private.granted_owner_ids_for(uuid, text) to service_role;
grant execute on function public.can_send_push(uuid, uuid, text) to service_role;
grant execute on function public.find_missed_wake_alarms(timestamptz, integer) to service_role;
