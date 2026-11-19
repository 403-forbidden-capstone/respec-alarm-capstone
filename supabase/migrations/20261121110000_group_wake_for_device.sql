-- 기상 알람 그룹 상태 안내 (group-status-device) — 폰 네이티브가 기기 키로 그룹원 상태를 읽는 길
--   기기 키 요청에는 로그인 토큰(auth.uid())이 없어 get_group_wake를 그대로 못 부름 → 서버 함수(service_role)가 사용자 id를 넘겨 같은 계산을 읽음
--   새 판정 없음: 내가 참여 중인 그룹마다 private.group_wake_rows(나, 그룹)의 get_group_wake 칸 + 그룹 이름. 공유 범위(동의 · 숨김 · 차단) · 약속 있는 날만 · 날짜(내 시간대의 오늘)도 그대로
--   p_user_id는 서버가 기기 키에서 찾은 값만 넘김 (_shared/briefing-device.ts deviceUser). 앱 역할은 못 부름

create function public.group_wake_for_device(p_user_id uuid)
returns table (
  group_id            uuid,
  group_name          varchar,
  user_id             uuid,
  nickname            varchar,
  is_me               boolean,
  wake_alarm_at       timestamptz,
  wake_confirmed_at   timestamptz,
  wake_status         text,
  departed_at         timestamptz,
  arrived_at          timestamptz,
  trip_visible        boolean,
  trip_appointment_at timestamptz,
  prepare_alarm_at    timestamptz,
  prepare_started_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.group_id, g.group_name, r.user_id, r.nickname, r.is_me, r.wake_alarm_at, r.wake_confirmed_at, r.wake_status,
         r.departed_at, r.arrived_at, r.trip_visible, r.trip_appointment_at, r.prepare_alarm_at, r.prepare_started_at
  from public.groups g
  join public.group_members gm on gm.group_id = g.group_id and gm.user_id = p_user_id and gm.invite_status = 'JOINED'
  cross join lateral private.group_wake_rows(p_user_id, g.group_id) r
  order by g.created_at, g.group_id, r.is_me desc, r.nickname;
$$;

revoke all on function public.group_wake_for_device(uuid) from public, anon, authenticated;
grant execute on function public.group_wake_for_device(uuid) to service_role;
