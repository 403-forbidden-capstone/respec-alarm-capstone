-- =====================================================================
-- 친구 8장 — 깨우기 · 미확인 알림 (친구 논리설계 8장, 11/8 확정)
--   ① push_sends(서버 전용) — 보낸 깨우기 · 친구 알림 기록. 깨우기 횟수(5분 1번 · 하루 3번) · 받은 깨우기 한 줄 · 같은 알림 두 번 방지가 이 표 하나
--   ② profiles.wake_ping_enabled — [깨우기 받기] 스위치 (기본 켬)
--   ③ plan_wake_ping — 깨울 수 있는지 판정, reserve면 같은 쌍 잠금 아래에서 다시 판정하고 횟수를 셈 (8-01 ~ 8-15 · 8-33 · 8-35)
--      can_send_push의 WAKE_PING도 같은 판정(보이는 사람이면 통과) — notify 서버 함수가 403으로 막는 것과 판정이 어긋나지 않게
--   ④ my_wake_pings — 오늘 받은 깨우기 한 줄 (8-18)
--   ⑤ claim_wake_nudges — 미확인 10분 뒤 '깨워 볼까요?'와 본인이 늦게 확인했을 때 후속 1회의 받는 사람을 정함 (8-21 ~ 8-30 · 8-36)
--   ⑥ get_wake_announcement — 알람이 울리기 직전 음성 안내용 그룹별 일어난 사람 수 (8-31)
-- 기상이 보이는 조건은 7장 group_wake_rows · can_see_wake 그대로 — 같은 그룹 · 상대가 그 그룹에 기상 공유 · 그 그룹 오늘 약속 · 숨김 / 차단 아님
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 보낸 기록 표 — 서버 전용
-- ---------------------------------------------------------------------

-- kind
--   WAKE_PING  깨우기. sender_id → target_id, sent_at = 보낸 때 (횟수 · 5분 간격 · 받은 한 줄)
--   NUDGE      '깨워 볼까요?'. target_id = 받은 사람, subject_id = 안 일어난 사람, day = 그 사람이 기상한 날 (같은 날 한 사람에게 한 번)
--   UP         '일어났어요' 후속. NUDGE와 같은 칸, 같은 날 한 번
-- 사람이 지워지면(탈퇴) 그 사람이 낀 줄도 같이 지워짐
create table public.push_sends (
  send_id     bigint generated always as identity primary key,
  kind        text not null check (kind in ('WAKE_PING', 'NUDGE', 'UP')),
  sender_id   uuid references public.profiles (user_id) on delete cascade,              -- WAKE_PING만
  target_id   uuid not null references public.profiles (user_id) on delete cascade,
  subject_id  uuid references public.profiles (user_id) on delete cascade,              -- NUDGE · UP만
  day         date,                                                                      -- NUDGE · UP만 (안 일어난 사람의 기상한 날)
  sent_at     timestamptz not null default now(),
  constraint push_sends_shape check (
    (kind = 'WAKE_PING' and sender_id is not null and subject_id is null and day is null)
    or (kind in ('NUDGE', 'UP') and sender_id is null and subject_id is not null and day is not null))
);

create index idx_push_sends_ping_pair   on public.push_sends (sender_id, target_id, sent_at desc) where kind = 'WAKE_PING';
create index idx_push_sends_ping_target on public.push_sends (target_id, sent_at desc)            where kind = 'WAKE_PING';
create unique index push_sends_nudge_key on public.push_sends (kind, target_id, subject_id, day)  where kind in ('NUDGE', 'UP');
create index idx_push_sends_nudge_sent  on public.push_sends (sent_at)                            where kind = 'NUDGE';

comment on table public.push_sends is '깨우기 · 미확인 친구 알림 보낸 기록 — 서버 전용. 횟수 · 5분 간격 · 받은 깨우기 한 줄 · 같은 알림 두 번 방지';

alter table public.push_sends enable row level security;
revoke all on public.push_sends from anon, authenticated;
grant select, insert, update, delete on public.push_sends to service_role;

-- 미확인(MISSED) 기록만 빠르게 (5분 배치가 최근 몇 시간만 봄)
create index idx_alarm_events_missed on public.alarm_events (event_at) where event_type = 'MISSED';


-- ---------------------------------------------------------------------
-- 2. [깨우기 받기] 스위치
-- ---------------------------------------------------------------------

-- 앱이 내 프로필을 직접 update (profiles_update_own). 다른 사람은 프로필을 못 읽으므로 꺼 둔 사실은 보낸 쪽 응답 OFF로만 드러남
alter table public.profiles add column wake_ping_enabled boolean not null default true;
comment on column public.profiles.wake_ping_enabled is '친구가 깨우기를 보낼 수 있게 할지 (설정 알림 줄 [깨우기 받기], 기본 켬). 끄면 보낸 쪽에 OFF만';


-- ---------------------------------------------------------------------
-- 3. 깨울 수 있는가 — 판정 한 곳
-- ---------------------------------------------------------------------

-- 상태: FORBIDDEN(기상이 안 보이는 사람 · 자기 자신 · 없는 사람 — 이유 구분 없음) → OFF → ALREADY_UP → NOT_RINGING → DAILY_LIMIT → WAIT → OK
--   보이는지: 보내는 사람 시점의 7장 group_wake_rows에 받는 사람 줄이 있어야 함 (같은 그룹 · 동의 · 그 그룹 오늘 약속 · 숨김 / 차단 아님). '오늘' = 받는 사람 시간대의 p_now 날짜
--   ALREADY_UP: 확인이 있거나 자동 판정(USAGE) 확인이 아직 20분 전이라 친구에게 안 보이는 중 (8-33) — 그동안 깨우기는 서버가 막음
--   NOT_RINGING: 그날 첫 기상 알람이 없거나 예정 시각 전. 예정 시각이 지났으면 울림 기록이 없어도 OK (폰이 꺼져 기록이 못 올라와도, 8-아)
--   한도: 보내는 사람 → 받는 사람 쌍마다 하루 3번(하루 = 받는 사람 시간대 0시) · 5분에 한 번. 하루 3번을 먼저 봄(한도가 찼는데 '5분 뒤'라고 하면 틀리므로)
-- 읽기만 함 — 횟수를 세는 것은 plan_wake_ping
create function private.wake_ping_verdict(p_sender uuid, p_target uuid, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz        text;
  v_enabled   boolean;
  v_date      date;
  v_day_start timestamptz;
  v_day_end   timestamptz;
  v_row       record;
  v_count     integer;
  v_last      timestamptz;
begin
  if p_sender is null or p_target is null or p_sender = p_target then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  select coalesce(pr.timezone, 'Asia/Seoul'), pr.wake_ping_enabled into v_tz, v_enabled
  from public.profiles pr
  where pr.user_id = p_target;
  if not found then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  v_date      := (p_now at time zone v_tz)::date;
  v_day_start := v_date::timestamp at time zone v_tz;
  v_day_end   := (v_date + 1)::timestamp at time zone v_tz;

  select r.wake_alarm_at, r.wake_status, r.confirm_pending into v_row
  from public.group_members gs
  cross join lateral private.group_wake_rows(p_sender, gs.group_id, v_date, p_now) r
  where gs.user_id = p_sender and gs.invite_status = 'JOINED'
    and r.user_id = p_target
  order by gs.group_id
  limit 1;
  if not found then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  if not v_enabled then
    return jsonb_build_object('status', 'OFF');
  end if;
  if v_row.wake_status = 'CONFIRMED' or v_row.confirm_pending then
    return jsonb_build_object('status', 'ALREADY_UP');
  end if;
  if v_row.wake_alarm_at is null or v_row.wake_alarm_at > p_now then
    return jsonb_build_object('status', 'NOT_RINGING');
  end if;

  select count(*)::integer, max(ps.sent_at) into v_count, v_last
  from public.push_sends ps
  where ps.kind = 'WAKE_PING' and ps.sender_id = p_sender and ps.target_id = p_target
    and ps.sent_at >= v_day_start and ps.sent_at < v_day_end;

  if v_count >= 3 then
    return jsonb_build_object('status', 'DAILY_LIMIT', 'resets_at', v_day_end);
  end if;
  if v_last is not null and v_last + interval '5 minutes' > p_now then
    return jsonb_build_object('status', 'WAIT', 'next_at', v_last + interval '5 minutes');
  end if;
  return jsonb_build_object('status', 'OK', 'count', v_count);
end;
$$;

-- notify 서버 함수가 부름 (서버 전용). p_reserve가 거짓이면 판정만 {status}, 참이면 같은 쌍을 잠그고(동시에 두 번 눌러도 횟수가 넘지 않게)
--   그 안에서 다시 판정한 뒤 통과하면 한 번 세고 {status:'OK', count, limit, next_at}를 돌려줌 (8-차 · 8-06 · 8-08). 횟수는 푸시를 보내기 직전에 셈(토큰이 없으면 reserve를 안 부름, 8-14)
-- p_now는 시험용(서버 함수는 기본값 = 지금)
create function public.plan_wake_ping(p_sender uuid, p_target uuid, p_reserve boolean default false, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        jsonb;
  v_count  integer;
begin
  if p_sender is null or p_target is null then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  if p_reserve then
    perform pg_advisory_xact_lock(hashtextextended('wake_ping:' || p_sender::text || ':' || p_target::text, 0));
  end if;

  v := private.wake_ping_verdict(p_sender, p_target, p_now);
  if v ->> 'status' <> 'OK' or not coalesce(p_reserve, false) then
    return v - 'count';
  end if;

  v_count := (v ->> 'count')::integer + 1;
  insert into public.push_sends (kind, sender_id, target_id, sent_at)
  values ('WAKE_PING', p_sender, p_target, p_now);
  return jsonb_build_object('status', 'OK', 'count', v_count, 'limit', 3, 'next_at', p_now + interval '5 minutes');
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 보내도 되는지 — 깨우기 추가
-- ---------------------------------------------------------------------

-- WAKE_PING  기상이 보이는 사람이면 통과 (판정 이유는 plan_wake_ping이 따로 돌려줌). 나머지는 11장 그대로
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
      when 'WAKE_PING' then (private.wake_ping_verdict(p_sender_id, p_target_id, now()) ->> 'status') <> 'FORBIDDEN'
      else false
    end
  end;
$$;


-- ---------------------------------------------------------------------
-- 5. 받은 깨우기 한 줄 — 홈 · H08 '수연님이 7:12에 깨웠어요'
-- ---------------------------------------------------------------------

-- 오늘(내 시간대, 또는 p_date) 내가 받은 깨우기, 최신 순. 차단한 사람 것은 뺌
create function public.my_wake_pings(p_date date default null)
returns table (sender_id uuid, sender_nickname varchar, sent_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid  uuid := (select auth.uid());
  v_tz   text;
  v_date date;
begin
  if v_uid is null then
    return;
  end if;
  select coalesce(pr.timezone, 'Asia/Seoul') into v_tz from public.profiles pr where pr.user_id = v_uid;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := coalesce(p_date, (now() at time zone v_tz)::date);

  return query
  select ps.sender_id, pr.nickname, ps.sent_at
  from public.push_sends ps
  join public.profiles pr on pr.user_id = ps.sender_id
  where ps.kind = 'WAKE_PING'
    and ps.target_id = v_uid
    and ps.sent_at >= (v_date::timestamp at time zone v_tz)
    and ps.sent_at <  ((v_date + 1)::timestamp at time zone v_tz)
    and not private.is_blocked_pair(v_uid, ps.sender_id)
  order by ps.sent_at desc, ps.send_id desc;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 미확인 친구 알림 — 받는 사람 정하기 (wake-check 5분 배치)
-- ---------------------------------------------------------------------

-- 본인 알림(WAKE_MISSED)은 서버 함수가 미확인 기록을 만들 때 바로 보냄. 여기는 그 다음 두 가지
--   NUDGE '깨워 볼까요?': 미확인(MISSED) 기록 10분 뒤(최근 12시간 안 기록만). 그사이 본인이 확인했으면 취소(8-21). 받는 사람 =
--     그 사람이 기상 공유에 동의한 그룹 중 '그날 그 그룹의 가장 이른 약속이 아직 안 시작한' 그룹의 참여 중 멤버로,
--     기상이 보이는 사람(can_see_wake — 동의 · 숨김 · 차단 반영)이고 그 그룹 알림을 안 껐으며(notifications_off), 같은 날 이미 받은 적이 없는 사람. 여러 그룹이어도 한 사람에게 한 번 (8-22 ~ 8-29)
--     그날 = 안 일어난 사람의 기상한 날, 시간대는 그 사람 것. 약속이 없는 날 · 약속 시각이 지난 뒤는 안 보냄 (8-24 ~ 8-26)
--   UP '일어났어요': NUDGE를 받은 사람에게, 본인이 그 뒤 확인했을 때(자동 판정은 20분 뒤부터 보임) 한 번 (8-30). 받는 사람이 여전히 볼 수 있고 알림을 안 껐을 때만
--   확인 인정은 7장과 같음: 직접 입력(MANUAL) · 대화 정정(VOICE) 출처는 뺌
-- 돌려주는 group_id = 누르면 열 그룹(받는 사람과 안 일어난 사람이 함께 있고 조건에 맞는 그룹 중 id가 가장 작은 것)
-- 정하면서 push_sends에 한 줄씩 남겨 같은 알림이 두 번 안 가게 함 (고유 인덱스 + on conflict do nothing — 배치가 겹쳐 돌아도 한 번)
create function public.claim_wake_nudges(p_now timestamptz default now())
returns table (event_key text, kind text, recipient_id uuid, sleeper_id uuid, group_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with cand as (
    select e.user_id as sleeper_id,
           coalesce(pr.timezone, 'Asia/Seoul') as tz,
           private.wake_day(e.alarm_id, e.event_at, coalesce(pr.timezone, 'Asia/Seoul')) as d,
           min(e.event_at) as missed_at
    from public.alarm_events e
    join public.alarms a on a.alarm_id = e.alarm_id and a.alarm_type = 'WAKE'
    join public.profiles pr on pr.user_id = e.user_id
    where e.event_type = 'MISSED'
      and e.event_at <= p_now - interval '10 minutes'
      and e.event_at >  p_now - interval '12 hours'
    group by e.user_id, coalesce(pr.timezone, 'Asia/Seoul'), private.wake_day(e.alarm_id, e.event_at, coalesce(pr.timezone, 'Asia/Seoul'))
  ),
  still_asleep as (
    select c.* from cand c
    where not exists (
      select 1 from public.alarm_events w
      where w.user_id = c.sleeper_id and w.event_type = 'WAKE_CONFIRMED'
        and w.event_at <= p_now and w.event_at >= c.missed_at - interval '1 day'
        and coalesce(w.input_source::text, '') not in ('MANUAL', 'VOICE')
        and private.wake_day(w.alarm_id, w.event_at, c.tz) = c.d)
  ),
  want as (
    select distinct on (s.sleeper_id, s.d, gm.user_id) s.sleeper_id, s.d, gm.user_id as recipient_id, gs.group_id
    from still_asleep s
    join public.group_members gs on gs.user_id = s.sleeper_id and gs.invite_status = 'JOINED' and gs.wake_share_opt_in
    join public.group_members gm on gm.group_id = gs.group_id and gm.invite_status = 'JOINED'
                                and gm.user_id <> s.sleeper_id and not gm.notifications_off
    where private.can_see_wake(gm.user_id, s.sleeper_id, gs.group_id)
      and (select min(ap.appointment_at)
           from public.appointments ap
           where ap.group_id = gs.group_id
             and ap.appointment_at >= (s.d::timestamp at time zone s.tz)
             and ap.appointment_at <  ((s.d + 1)::timestamp at time zone s.tz)) > p_now
    order by s.sleeper_id, s.d, gm.user_id, gs.group_id
  ),
  ins as (
    insert into public.push_sends (kind, target_id, subject_id, day, sent_at)
    select 'NUDGE', w.recipient_id, w.sleeper_id, w.d, p_now from want w
    on conflict (kind, target_id, subject_id, day) where kind in ('NUDGE', 'UP') do nothing
    returning target_id, subject_id, day
  )
  select 'NUDGE:' || i.subject_id::text || ':' || i.day::text || ':' || i.target_id::text, 'NUDGE'::text, i.target_id, i.subject_id, w.group_id
  from ins i
  join want w on w.recipient_id = i.target_id and w.sleeper_id = i.subject_id and w.d = i.day;

  return query
  with later_up as (
    select n.target_id, n.subject_id, n.day, g.group_id
    from public.push_sends n
    join public.profiles pr on pr.user_id = n.subject_id
    cross join lateral (
      select gs.group_id
      from public.group_members gs
      join public.group_members gm on gm.group_id = gs.group_id and gm.invite_status = 'JOINED' and gm.user_id = n.target_id and not gm.notifications_off
      where gs.user_id = n.subject_id and gs.invite_status = 'JOINED'
        and private.can_see_wake(gm.user_id, gs.user_id, gs.group_id)
      order by gs.group_id
      limit 1) g
    where n.kind = 'NUDGE'
      and n.sent_at > p_now - interval '12 hours'
      and not exists (select 1 from public.push_sends u
                      where u.kind = 'UP' and u.target_id = n.target_id and u.subject_id = n.subject_id and u.day = n.day)
      and exists (
        select 1 from public.alarm_events w
        where w.user_id = n.subject_id and w.event_type = 'WAKE_CONFIRMED'
          and w.event_at <= p_now and w.event_at >= n.sent_at - interval '1 day'
          and coalesce(w.input_source::text, '') not in ('MANUAL', 'VOICE')
          and (w.input_source is distinct from 'USAGE' or w.event_at <= p_now - interval '20 minutes')
          and private.wake_day(w.alarm_id, w.event_at, coalesce(pr.timezone, 'Asia/Seoul')) = n.day)
  ),
  ins as (
    insert into public.push_sends (kind, target_id, subject_id, day, sent_at)
    select 'UP', u.target_id, u.subject_id, u.day, p_now from later_up u
    on conflict (kind, target_id, subject_id, day) where kind in ('NUDGE', 'UP') do nothing
    returning target_id, subject_id, day
  )
  select 'UP:' || i.subject_id::text || ':' || i.day::text || ':' || i.target_id::text, 'UP'::text, i.target_id, i.subject_id, u.group_id
  from ins i
  join later_up u on u.target_id = i.target_id and u.subject_id = i.subject_id and u.day = i.day;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. 음성 안내 — '캡스톤팀 2명이 일어났어요'
-- ---------------------------------------------------------------------

-- 오늘 약속이 있는 내 그룹마다 그룹 이름 + 일어난 사람 수(내가 볼 수 있는 사람 중 기상 확인이 된 사람, 나 빼고). 사람 이름은 안 줌.
--   일어난 사람이 없는 그룹은 줄이 없음 → 앱이 그 문장을 뺌. 사람 많은 그룹 먼저. p_now는 시험용
create function private.wake_announcement(p_viewer uuid, p_now timestamptz default now())
returns table (group_id uuid, group_name text, up_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select g.group_id, g.group_name::text, (count(*))::integer
  from public.group_members gm
  join public.groups g on g.group_id = gm.group_id
  cross join lateral private.group_wake_rows(p_viewer, gm.group_id, null, p_now) r
  where gm.user_id = p_viewer and gm.invite_status = 'JOINED'
    and not r.is_me
    and r.wake_status = 'CONFIRMED' and r.wake_confirmed_at <= p_now
  group by g.group_id, g.group_name
  order by count(*) desc, g.group_name, g.group_id;
$$;

create function public.get_wake_announcement()
returns table (group_id uuid, group_name text, up_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.wake_announcement((select auth.uid()), now());
$$;


-- ---------------------------------------------------------------------
-- 8. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function private.wake_ping_verdict(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function private.wake_announcement(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.plan_wake_ping(uuid, uuid, boolean, timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_wake_nudges(timestamptz) from public, anon, authenticated;
grant execute on function public.plan_wake_ping(uuid, uuid, boolean, timestamptz) to service_role;
grant execute on function public.claim_wake_nudges(timestamptz) to service_role;

revoke execute on function public.my_wake_pings(date) from public, anon;
revoke execute on function public.get_wake_announcement() from public, anon;
grant execute on function public.my_wake_pings(date) to authenticated;
grant execute on function public.get_wake_announcement() to authenticated;
