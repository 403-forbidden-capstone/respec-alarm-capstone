-- 공동 일정은 그룹원 누구나 고치고 지움 (#619, D41 갱신)
--   만든 사람(creator_id)은 기록으로만 남기고 권한 판단에서 뺌. 개인 일정은 그대로 만든 사람만
--   공동 일정 조건 = 그 그룹에 참여 중(JOINED) + 안 지난 약속(부른 사람 시간대의 오늘 0시, 고치기 · 지우기 같은 하루 경계). 나간 · 내보내진 사람은 못 함
--   지난 정의: appointments_update = 20261109011723_friend_wake_ping.sql, appointments_delete_creator = 20261109090000_friend_explore_fixes.sql,
--             plan_group_push = 20261109011723_friend_wake_ping.sql (달라진 곳 = 약속 변경 알림의 보낸 사람 조건에서 '만든 사람 · 참여자'를 뺌 — 참여 중인 그룹원이면 보냄)

drop policy appointments_update on public.appointments;
create policy appointments_update on public.appointments
  for update to authenticated
  using (
    (group_id is null and creator_id = (select auth.uid()))
    or (group_id is not null
        and appointment_at >= private.day_start((select auth.uid()))
        and private.is_group_member(group_id)))
  with check (
    (group_id is null and creator_id = (select auth.uid()))
    or (group_id is not null
        and appointment_at >= private.day_start((select auth.uid()))
        and private.is_group_member(group_id)));

drop policy appointments_delete_creator on public.appointments;
create policy appointments_delete_creator on public.appointments
  for delete to authenticated
  using (
    (group_id is null and creator_id = (select auth.uid()))
    or (group_id is not null
        and appointment_at >= private.day_start((select auth.uid()))
        and private.is_group_member(group_id)));

create or replace function public.plan_group_push(p_sender_id uuid, p_group_id uuid, p_kind text, p_appointment_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_group_name text;
  v_joined_at  timestamptz;
  v_title      text;
begin
  if p_sender_id is null or p_group_id is null or p_kind is null or p_kind not in ('GROUP_MEMBER_JOINED', 'GROUP_APPT_CHANGED') then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  select g.group_name, gm.joined_at into v_group_name, v_joined_at
  from public.groups g
  join public.group_members gm on gm.group_id = g.group_id
  where g.group_id = p_group_id and gm.user_id = p_sender_id and gm.invite_status = 'JOINED';
  if not found then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  if p_kind = 'GROUP_MEMBER_JOINED' then
    if v_joined_at is null or v_joined_at < now() - interval '10 minutes' then
      return jsonb_build_object('status', 'FORBIDDEN');
    end if;
  else
    select ap.title into v_title
    from public.appointments ap
    where ap.appointment_id = p_appointment_id and ap.group_id = p_group_id
      and ap.appointment_at >= private.day_start(p_sender_id);
    if not found then
      return jsonb_build_object('status', 'FORBIDDEN');
    end if;
  end if;

  return jsonb_build_object(
    'status', 'OK',
    'group_name', v_group_name,
    'appointment_title', v_title,
    'recipients', coalesce((
      select jsonb_agg(gm.user_id order by gm.user_id)
      from public.group_members gm
      where gm.group_id = p_group_id
        and gm.invite_status = 'JOINED'
        and gm.user_id <> p_sender_id
        and not gm.notifications_off
        and not private.is_blocked_pair(p_sender_id, gm.user_id)
        and (p_kind = 'GROUP_MEMBER_JOINED' or exists (
              select 1 from public.appointment_participants pt where pt.appointment_id = p_appointment_id and pt.user_id = gm.user_id))
    ), '[]'::jsonb),
    'silent_recipients', case when p_kind = 'GROUP_APPT_CHANGED' then coalesce((
      select jsonb_agg(gm.user_id order by gm.user_id)
      from public.group_members gm
      where gm.group_id = p_group_id
        and gm.invite_status = 'JOINED'
        and gm.user_id <> p_sender_id
        and (gm.notifications_off or private.is_blocked_pair(p_sender_id, gm.user_id))
        and exists (
              select 1 from public.appointment_participants pt where pt.appointment_id = p_appointment_id and pt.user_id = gm.user_id)
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;
