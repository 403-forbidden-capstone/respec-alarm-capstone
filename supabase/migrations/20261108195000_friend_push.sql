-- =====================================================================
-- 친구 11장 — 푸시 바탕 (친구 논리설계 11장, 11/8 확정)
--   ① 푸시 영수증 표 push_tickets(서버 전용) — 보낸 지 15분 뒤 wake-check 배치가 Expo 영수증을 확인해 앱이 지워진 기기의 토큰을 지움 (11-06 · 11-07)
--   ② 토큰 등록 입력 검사 — Expo 토큰 모양 · 플랫폼 android / ios (11-01, 웹은 푸시를 안 받음), 사용자당 최대 10대, 앱의 직접 쓰기 길 회수
--   ③ can_send_push에 FRIEND_REQUEST · FRIEND_ACCEPTED (11-12 · 11-13)
--   ④ plan_group_push — 그룹 알림(새 멤버 · 공동 약속 변경)의 받는 사람을 서버가 고름: 알림 끈 멤버 · 차단 쌍 · 보낸 사람 제외 (11-14 ~ 11-16, 11-라)
-- 문구 · 채널 · 알림 데이터는 notify 서버 함수(supabase/functions/_shared/notify.ts)가 종류별로 고정
-- 깨우기 허용 조건(WAKE_PING)은 8장, 알람 바꾸기 내용(ALARM_CHANGED)은 10장, 공동 약속 변경을 부르는 곳은 9장
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 푸시 영수증 표 — Expo가 접수한 알림(ticket)마다 한 줄, 15분 뒤 영수증을 확인하고 지움 (영수증이 아직 없으면 다음 배치에 다시, 24시간 뒤엔 포기)
-- ---------------------------------------------------------------------

create table public.push_tickets (
  ticket_id          text primary key,                                                      -- Expo가 돌려준 접수 번호
  user_id            uuid not null references public.profiles (user_id) on delete cascade,  -- 받는 사람 (탈퇴하면 같이 지워짐)
  token              text not null,                                                         -- 보낸 기기 토큰 (영수증이 DeviceNotRegistered면 지움)
  kind               text not null,                                                         -- 알림 종류 (기록용)
  created_at         timestamptz not null default now()                                     -- 15분이 지나면 영수증을 확인하고 지움, 24시간이 지나도 영수증이 없으면 그냥 지움
);

create index idx_push_tickets_created on public.push_tickets (created_at);

comment on table public.push_tickets is '푸시 영수증 확인 대기 — 서버 전용. wake-check 배치가 15분 뒤 확인하고 지움';

alter table public.push_tickets enable row level security;
revoke all on public.push_tickets from anon, authenticated;
grant select, insert, update, delete on public.push_tickets to service_role;


-- ---------------------------------------------------------------------
-- 2. 토큰 등록 입력 검사 (로그인마다 다시 등록, 같은 폰의 토큰은 마지막 로그인 계정이 가짐 — 11-사 · 15-아)
-- ---------------------------------------------------------------------

create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) > 200 or p_token !~ '^Expo(nent)?PushToken\[[^\]]+\]$' then
    raise exception '푸시 토큰 모양이 맞지 않음' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('android', 'ios') then
    raise exception '지원하지 않는 플랫폼임' using errcode = '22023';
  end if;

  insert into public.push_tokens (user_id, token, platform)
  values (v_uid, p_token, p_platform)
  on conflict (token) do update
    set user_id      = excluded.user_id,
        platform     = excluded.platform,
        last_seen_at = now();

  -- 한 사람이 쌓을 수 있는 기기는 최대 10대: 넘으면 가장 오래 전에 등록한 것부터 지움(폰을 바꾸거나 앱을 다시 깔면 새 토큰이 생기므로 거절하지 않고 밀어냄).
  --   한 사람이 토큰을 잔뜩 만들어 다른 멤버의 그룹 푸시 조회를 밀어내지 못하게 (조회 상한 max_rows)
  delete from public.push_tokens pt
  where pt.user_id = v_uid
    and pt.token not in (
      select t.token from public.push_tokens t
      where t.user_id = v_uid
      order by t.last_seen_at desc, t.created_at desc, t.token
      limit 10);
end;
$$;

-- 토큰은 register_push_token으로만 넣고 고침(입력 검사 · 개수 상한이 여기 있음). 앱 역할의 직접 insert · update는 회수 — 읽기와 지우기(로그아웃)는 그대로 (15-라)
revoke insert, update on public.push_tokens from anon, authenticated;
drop policy push_tokens_insert_own on public.push_tokens;
drop policy push_tokens_update_own on public.push_tokens;


-- ---------------------------------------------------------------------
-- 3. 보내도 되는지 (한 사람에게) — 종류 추가
-- ---------------------------------------------------------------------

-- ALARM_CHANGED  보내는 사람이 받는 사람의 알람에 설정 권한(조회도 함께, 6장)을 가졌을 때 (내용은 10장)
-- WAKE_PING      8장에서 조건을 정할 때까지 거절
-- FRIEND_REQUEST 보내는 사람이 받는 사람에게 방금(1시간 안) 보낸 대기 요청이 있을 때 (받는 사람에게만) — 오래된 대기 요청으로 다시 보내지 못하게
-- FRIEND_ACCEPTED 받는 사람이 보낸 요청을 보내는 사람이 방금(1시간 안) 수락했을 때 (요청한 사람에게만) — 오래된 수락으로 다시 보내지 못하게
-- 그룹 알림은 받는 사람이 여럿이라 plan_group_push가 따로 고름. 미확인 본인(WAKE_MISSED)은 앱이 아니라 배치가 보냄 → 앱 요청은 거절
-- 차단 쌍이면 종류와 상관없이 거절
create or replace function public.can_send_push(p_sender_id uuid, p_target_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_sender_id is null or p_target_id is null then false
    when private.is_blocked_pair(p_sender_id, p_target_id) then false
    else case p_kind
      when 'ALARM_CHANGED' then coalesce(
        p_target_id in (select private.granted_owner_ids_for(p_sender_id, 'EDIT_ALARM')),
        false)
      when 'FRIEND_REQUEST' then exists (
        select 1 from public.friends f
        where f.status = 'PENDING' and f.requester_id = p_sender_id and f.addressee_id = p_target_id
          and f.requested_at >= now() - interval '1 hour')
      when 'FRIEND_ACCEPTED' then exists (
        select 1 from public.friends f
        where f.status = 'ACCEPTED' and f.requester_id = p_target_id and f.addressee_id = p_sender_id
          and f.accepted_at >= now() - interval '1 hour')
      -- when 'WAKE_PING' then ... 8장
      else false
    end
  end;
$$;


-- ---------------------------------------------------------------------
-- 4. 그룹 알림 — 받는 사람은 서버가 고름 (앱은 그룹 · 약속 id만 보냄)
-- ---------------------------------------------------------------------

-- 보낸 사람이 그 그룹에 참여 중이어야 하고, 새 멤버 알림은 들어온 지 10분 안(들어온 사람이 보냄), 약속 변경은 그 그룹의 아직 지나지 않은 약속을
-- 만든 사람(만든 사람이 비어 있으면 참여자)이 보낼 때만 — 시각 · 장소 수정은 만든 사람만(9-자), 위조로 아무 약속이나 '바뀌었어요'를 보내지 못하게.
-- 받는 사람 = 새 멤버 알림은 참여 중 멤버 전체, 약속 변경은 그 약속에 참여 조건이 있는 참여 중 멤버(9-더) − 보낸 사람 − 알림 끈 멤버(notifications_off) − 보낸 사람과 차단 쌍.
-- 문구에 쓸 그룹 이름 · 약속 제목을 같이 돌려줌(사람 이름은 안 돌려줌)
-- 안 되는 모든 경우(참여 중이 아님 · 없는 그룹 · 약속이 맞지 않음 · 모르는 종류)는 같은 FORBIDDEN
create function public.plan_group_push(p_sender_id uuid, p_group_id uuid, p_kind text, p_appointment_id uuid default null)
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
      and ap.appointment_at > now()
      and (ap.creator_id = p_sender_id
           or (ap.creator_id is null and exists (
                 select 1 from public.appointment_participants pt where pt.appointment_id = ap.appointment_id and pt.user_id = p_sender_id)));
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
    ), '[]'::jsonb)
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 실행 권한 — 서버 함수(service_role)만
-- ---------------------------------------------------------------------

revoke execute on function public.plan_group_push(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.plan_group_push(uuid, uuid, text, uuid) to service_role;
