-- =====================================================================
-- 친구 7장 — 그룹 기상 상태 (친구 논리설계 7장, 11/8 확정)
--   ① get_group_wake          줄인 응답: 단계 · 알람 시각 · 확인 시각만 (미루기 횟수 · 알람 끈 시각 · 울린 시각 · 미확인 시각은 빼서 서버가 보일 값만 돌려줌) (7-거 · 13-자 · 7-37)
--                            하루는 사람마다 프로필 시간대로 셈, 새벽 약속은 알람이 울린 날 (7-자 · X-1), 같은 날 첫 기상 알람 시각 (7-차)
--                            자동 판정(폰 사용) 기상은 20분 뒤부터 다른 사람에게 보임 (D61), 저녁 직접 입력 · 대화 정정 출처는 그룹에 안 띄움 (7-타)
--                            폰이 꺼져 기록이 못 올라와도 알람 시각이 지나고 30분 동안 확인이 없으면 미확인과 같게 (7-마)
--   ② get_group_wake_status    옛 11칸 모양의 호환 함수 — 같은 값을 줄여 돌려줌(내 줄만 울린 시각 · 미루기 · 해제 · 미확인 칸이 참). 앱이 ①로 옮기면 15장에서 지움
--   ③ 사람별 기상 숨기기        wake_hides 표 + set_wake_hidden (친구 · 친구 아닌 그룹원 모두) (7-더 · Q13)
--   ④ 기상 확인 하루 한 건      사람마다 하루 첫 한 건만 저장(먼저 것 유지), 저장될 때 그날 daily_records 기상 시각도 같이 (7-d4 · 7-d5 · 7-하)
--   ⑤ 새로 고침 신호            직접 입력 · 대화 정정 · 자동 판정이 만든 기록은 신호를 안 냄, 새벽 약속은 알람이 울린 날 기준 (7-머)
--   ⑥ 미확인 시각 식            다시 울림 몫을 뺌: 미확인 시각 = 마지막 울림 시작 + 30분 (D2)
-- "기상 보임" 판정(private.can_see_wake)은 ① · 8장 깨우기가 같은 한 곳을 씀
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 사람별 기상 숨기기 — 내 기상을 특정 사람에게만 가림
-- ---------------------------------------------------------------------

-- (주인, 숨김 대상) 한 줄. 친구든 친구 아닌 그룹원이든 같은 표 하나 — 모든 그룹에 적용됨.
-- 쓰기는 set_wake_hidden으로만 (앱은 읽기만, 그것도 내가 숨긴 줄만 — 숨김당한 쪽은 몰라야 함)
create table public.wake_hides (
  owner_id       uuid not null references public.profiles (user_id) on delete cascade,   -- 기상을 숨기는 사람
  hidden_from_id uuid not null references public.profiles (user_id) on delete cascade,   -- 숨김당하는 사람
  created_at     timestamptz not null default now(),
  primary key (owner_id, hidden_from_id),
  constraint wake_hides_not_self check (owner_id <> hidden_from_id)
);

create index idx_wake_hides_hidden_from on public.wake_hides (hidden_from_id);

comment on table public.wake_hides is '기상 숨기기 — owner가 hidden_from에게 자기 기상을 안 보임. 쓰기는 set_wake_hidden으로만, 앱은 owner 본인 줄만 읽음';

alter table public.wake_hides enable row level security;
revoke all on public.wake_hides from anon, authenticated;
grant select on public.wake_hides to authenticated;
grant select, insert, update, delete on public.wake_hides to service_role;

create policy wake_hides_select_own on public.wake_hides
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- G02 멤버 메뉴 [이 사람에게 기상 숨기기 / 보이기]
--   숨기기는 같은 그룹이거나 친구인 사람만(나 자신 · 없는 사람 · 관계 없는 사람은 NOT_FOUND). 보이기(거두기)는 관계가 끊겨도 됨 — 옛 줄을 치울 수 있게
--   이미 숨겼는데 또 숨겨도 OK(행 하나). 상대는 모름 — 상대 화면은 숨김 · 동의 안 함 · 차단이 같은 모습
create function public.set_wake_hidden(p_user_id uuid, p_hidden boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = v_uid or p_hidden is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if not p_hidden then
    delete from public.wake_hides h where h.owner_id = v_uid and h.hidden_from_id = p_user_id;
    return jsonb_build_object('status', 'OK');
  end if;

  if not exists (select 1 from public.profiles p where p.user_id = p_user_id)
     or not (
       private.friend_relation(v_uid, p_user_id) = 'FRIEND'
       or exists (
         select 1
         from public.group_members a
         join public.group_members b on b.group_id = a.group_id
         where a.user_id = v_uid and a.invite_status = 'JOINED'
           and b.user_id = p_user_id and b.invite_status = 'JOINED')
     ) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  insert into public.wake_hides (owner_id, hidden_from_id) values (v_uid, p_user_id)
  on conflict (owner_id, hidden_from_id) do nothing;
  return jsonb_build_object('status', 'OK');
end;
$$;


-- ---------------------------------------------------------------------
-- 2. "기상이 보이는가" 한 곳 — 그룹 기상 상태 · 8장 깨우기가 같이 씀
-- ---------------------------------------------------------------------

-- 보는 사람이 그 그룹에서 주인의 기상을 볼 수 있으려면:
--   둘 다 그 그룹에 참여 중 · 주인이 그 그룹에서 기상 공유에 동의(wake_share_opt_in, 그룹마다 따로) · 차단 쌍이 아님 · 주인이 보는 사람에게 숨기지 않음 (Q13)
--   내 기상을 내가 보는 건 이 판정과 상관없이 늘 가능(호출하는 쪽에서 처리)
create function private.can_see_wake(p_viewer uuid, p_owner uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.group_members gv
      join public.group_members go on go.group_id = gv.group_id
      where gv.group_id = p_group_id
        and gv.user_id = p_viewer and gv.invite_status = 'JOINED'
        and go.user_id = p_owner and go.invite_status = 'JOINED' and go.wake_share_opt_in)
    and not private.is_blocked_pair(p_viewer, p_owner)
    and not exists (select 1 from public.wake_hides h where h.owner_id = p_owner and h.hidden_from_id = p_viewer),
    false);
$$;

-- 그날(p_date, 시간대 p_tz) 이 그룹에 '약속 있는 날'인가:
--   그 그룹 약속이 그 날짜에 있거나, 그 그룹 약속에 참여한 사람의 기상 알람이 그 사람 시간대의 그 날짜에 울릴 때(새벽 약속의 전날 밤 알람, 7-자)
create function private.group_wake_has_meeting(p_group_id uuid, p_date date, p_tz text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.appointments ap
           where ap.group_id = p_group_id
             and ap.appointment_at >= (p_date::timestamp at time zone p_tz)
             and ap.appointment_at <  ((p_date + 1)::timestamp at time zone p_tz))
      or exists (
           select 1
           from public.appointments ap
           join public.appointment_participants pt on pt.appointment_id = ap.appointment_id
           join public.alarms a on a.participant_id = pt.participant_id and a.alarm_type = 'WAKE' and a.is_enabled
           join public.profiles pr on pr.user_id = a.user_id
           where ap.group_id = p_group_id
             and a.scheduled_at >= (p_date::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul'))
             and a.scheduled_at <  ((p_date + 1)::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')));
$$;


-- ---------------------------------------------------------------------
-- 3. 그룹 기상 상태 본문 — 모든 값을 갖고 있고, 공개 함수가 보일 칸만 골라 돌려줌
-- ---------------------------------------------------------------------

-- p_viewer 시점의 줄들: 나 + 이 그룹에서 보이는 멤버(can_see_wake). p_now는 시험용(공개 함수는 지금)
-- 사람마다 하루 = 그 사람 프로필 시간대의 p_date. 그날 첫 기상 알람(켜진 것)이 그날의 기준 알람
-- 기록은 그 알람(들)의 [알람 시각 6시간 전, 18시간 뒤) 안 (find_missed_wake_alarms와 같은 구간)
--   울림 · 미루기 · 해제 · 미확인: 그날 기상 알람 전부의 기록
--   기상 확인: 그 사람의 WAKE_CONFIRMED 중 직접 입력(MANUAL) · 대화 정정(VOICE) 출처는 뺌. 자동 판정(USAGE)은 다른 사람에게는 20분 뒤부터(내 줄은 바로)
--   daily_records(저녁에 직접 입력한 기상 시각)는 안 읽음
-- 단계: CONFIRMED > MISSED > DISMISSED > RINGING > SCHEDULED, 알람이 없으면 NO_ALARM
--   MISSED = 서버가 기록한 MISSED, 또는 확인이 없는 채 (마지막 울림 시작 + 30분)이 지남. 마지막 울림 시작 = 그날 첫 알람의 마지막 미루기 끝(없으면 알람 시각)
--   20분을 기다리는 자동 판정 확인이 있으면 MISSED로 보지 않음(곧 일어남으로 바뀔 것)
create function private.group_wake_rows(p_viewer uuid, p_group_id uuid, p_date date default null, p_now timestamptz default now())
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,
  rang_at           timestamptz,
  snooze_count      integer,
  dismissed_at      timestamptz,
  wake_confirmed_at timestamptz,
  missed_at         timestamptz,
  wake_status       text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz   text;
  v_date date;
begin
  if p_viewer is null or p_group_id is null or not exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_viewer and gm.invite_status = 'JOINED'
  ) then
    return;
  end if;

  select p.timezone into v_tz from public.profiles p where p.user_id = p_viewer;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := coalesce(p_date, (p_now at time zone v_tz)::date);

  if not private.group_wake_has_meeting(p_group_id, v_date, v_tz) then
    return;
  end if;

  return query
  with members as (
    select gm.user_id,
           (v_date::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul'))       as w_from,
           ((v_date + 1)::timestamp at time zone coalesce(pr.timezone, 'Asia/Seoul')) as w_to
    from public.group_members gm
    join public.profiles pr on pr.user_id = gm.user_id
    where gm.group_id = p_group_id
      and gm.invite_status = 'JOINED'
      and (gm.user_id = p_viewer or private.can_see_wake(p_viewer, gm.user_id, p_group_id))
  ),
  day_alarms as (
    select a.alarm_id, a.user_id, a.scheduled_at
    from public.alarms a
    join members m on m.user_id = a.user_id
    where a.alarm_type = 'WAKE'
      and a.is_enabled
      and a.scheduled_at >= m.w_from
      and a.scheduled_at <  m.w_to
  ),
  first_alarm as (
    select distinct on (d.user_id) d.user_id, d.alarm_id, d.scheduled_at
    from day_alarms d
    order by d.user_id, d.scheduled_at, d.alarm_id
  ),
  ev as (
    select d.user_id, (d.alarm_id = f.alarm_id) as is_first, e.event_type, e.event_at, e.snooze_minutes
    from day_alarms d
    join first_alarm f on f.user_id = d.user_id
    join public.alarm_events e on e.alarm_id = d.alarm_id
      and e.event_type in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED')
      and e.event_at >= d.scheduled_at - interval '6 hours'
      and e.event_at <  d.scheduled_at + interval '18 hours'
  ),
  agg as (
    select ev.user_id,
           min(ev.event_at) filter (where ev.event_type = 'TRIGGERED') as rang_at,
           (count(*) filter (where ev.event_type = 'SNOOZED'))::integer as snoozes,
           min(ev.event_at) filter (where ev.event_type = 'DISMISSED') as dismissed_at,
           min(ev.event_at) filter (where ev.event_type = 'MISSED')    as missed_event_at,
           max(ev.event_at + make_interval(mins => coalesce(ev.snooze_minutes, 0))) filter (where ev.event_type = 'SNOOZED' and ev.is_first) as last_snooze_end
    from ev
    group by ev.user_id
  ),
  conf as (
    select f.user_id,
           min(e.event_at) filter (where vis.ok) as confirmed_at,
           coalesce(bool_or(not vis.ok), false)  as pending
    from first_alarm f
    join public.alarm_events e on e.user_id = f.user_id
      and e.event_type = 'WAKE_CONFIRMED'
      and e.event_at >= f.scheduled_at - interval '6 hours'
      and e.event_at <  f.scheduled_at + interval '18 hours'
      and coalesce(e.input_source::text, '') not in ('MANUAL', 'VOICE')
    cross join lateral (
      select (f.user_id = p_viewer
              or e.input_source is distinct from 'USAGE'
              or e.event_at <= p_now - interval '20 minutes') as ok
    ) vis
    group by f.user_id
  )
  select m.user_id,
         pr.nickname,
         pr.profile_image_url,
         (m.user_id = p_viewer),
         f.scheduled_at,
         ag.rang_at,
         coalesce(ag.snoozes, 0)::integer,
         ag.dismissed_at,
         c.confirmed_at,
         case
           when c.confirmed_at is not null or f.alarm_id is null then null
           when ag.missed_event_at is not null then ag.missed_event_at
           when not coalesce(c.pending, false) and p_now >= due.due_at then due.due_at
         end,
         case
           when c.confirmed_at is not null then 'CONFIRMED'
           when f.alarm_id is null then 'NO_ALARM'
           when ag.missed_event_at is not null or (not coalesce(c.pending, false) and p_now >= due.due_at) then 'MISSED'
           when ag.dismissed_at is not null then 'DISMISSED'
           when ag.rang_at is not null then 'RINGING'
           else 'SCHEDULED'
         end
  from members m
  join public.profiles pr on pr.user_id = m.user_id
  left join first_alarm f on f.user_id = m.user_id
  left join agg ag on ag.user_id = m.user_id
  left join conf c on c.user_id = m.user_id
  cross join lateral (
    select greatest(f.scheduled_at, coalesce(ag.last_snooze_end, f.scheduled_at)) + interval '30 minutes' as due_at
  ) due
  order by (m.user_id = p_viewer) desc, pr.nickname;
end;
$$;

-- 앱이 부르는 줄인 응답: 단계 · 알람 시각 · 확인 시각만 (7-거 · 7-37)
create function public.get_group_wake(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,
  wake_confirmed_at timestamptz,
  wake_status       text          -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM (앱이 아직 · 울렸어요 · 일어남 · 알람 없음으로 묶음)
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at, r.wake_confirmed_at, r.wake_status
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r;
$$;

-- 옛 모양(11칸) 호환 — 앱이 get_group_wake로 옮길 때까지. 내 줄만 울린 시각 · 미루기 · 해제 · 미확인 칸이 차고 다른 사람 줄은 비어 있음(미루기 0)
create or replace function public.get_group_wake_status(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,   -- 그날 첫 기상 알람 시각
  rang_at           timestamptz,   -- 기상 알람이 처음 울린 시각 (내 줄만)
  snooze_count      integer,       -- 미루기 횟수 (내 줄만, 남은 0)
  dismissed_at      timestamptz,   -- 알람 해제 시각 (내 줄만)
  wake_confirmed_at timestamptz,   -- 기상 확인 시각
  missed_at         timestamptz,   -- 기상 확인 없이 놓친 시각 (내 줄만)
  wake_status       text           -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.user_id, r.nickname, r.profile_image_url, r.is_me, r.wake_alarm_at,
         case when r.is_me then r.rang_at end,
         case when r.is_me then r.snooze_count else 0 end,
         case when r.is_me then r.dismissed_at end,
         r.wake_confirmed_at,
         case when r.is_me then r.missed_at end,
         r.wake_status
  from private.group_wake_rows((select auth.uid()), p_group_id, p_date) r;
$$;


-- ---------------------------------------------------------------------
-- 4. 기상 확인은 하루 한 건 + 하루 기록의 기상 시각 같이
-- ---------------------------------------------------------------------

-- 같은 사람의 같은 날(그 사람 시간대) 둘째 기상 확인은 오류 없이 저장하지 않음 — 폰 · 웹이 겹치면 먼저 들어온 것(출처도 그것)이 남음.
-- 같은 사람 같은 날은 잠금으로 줄을 세워 동시에 들어와도 한 건만 (7-d4)
create function private.limit_wake_confirmed_per_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz   text;
  v_date date;
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := (new.event_at at time zone v_tz)::date;
  perform pg_advisory_xact_lock(hashtextextended('wake_confirmed:' || new.user_id::text || ':' || v_date::text, 0));
  if exists (
    select 1 from public.alarm_events e
    where e.user_id = new.user_id
      and e.event_type = 'WAKE_CONFIRMED'
      and e.event_at >= (v_date::timestamp at time zone v_tz)
      and e.event_at <  ((v_date + 1)::timestamp at time zone v_tz)
  ) then
    return null;
  end if;
  return new;
end;
$$;

create trigger limit_wake_confirmed_per_day
  before insert on public.alarm_events
  for each row when (new.event_type = 'WAKE_CONFIRMED')
  execute function private.limit_wake_confirmed_per_day();

-- 저장된 기상 확인이 그날 하루 기록(daily_records)의 기상 확인 시각으로도 남음 — 이미 있는 값은 덮지 않음(7-하)
create function private.record_wake_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  insert into public.daily_records (user_id, record_date, wake_confirmed_at, data_source)
  values (new.user_id, (new.event_at at time zone coalesce(v_tz, 'Asia/Seoul'))::date, new.event_at, 'ALARM')
  on conflict (user_id, record_date) do update
    set wake_confirmed_at = coalesce(public.daily_records.wake_confirmed_at, excluded.wake_confirmed_at);
  return null;
end;
$$;

create trigger record_wake_on_confirm
  after insert on public.alarm_events
  for each row when (new.event_type = 'WAKE_CONFIRMED')
  execute function private.record_wake_on_confirm();


-- ---------------------------------------------------------------------
-- 5. 새로 고침 신호 — 직접 입력 · 대화 정정 · 자동 판정은 안 냄, 새벽 약속은 알람이 울린 날
-- ---------------------------------------------------------------------

-- 지난 정의(group_wake ⑥)와 같고 달라진 곳:
--   · 기록의 출처가 직접 입력(MANUAL) · 대화 정정(VOICE) · 자동 판정(USAGE)이면 신호를 안 냄 (자동 판정은 20분 뒤부터 보이니 그때까지 보일 게 없음)
--   · 날짜 = 그 기상 알람이 울린 날(그 사람 시간대), 알람이 기상 알람이 아니면 기록한 날. '약속 있는 날'도 같은 판정(group_wake_has_meeting)
create or replace function private.send_wake_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz       text;
  v_alarm_at timestamptz;
  v_date     date;
  v_group    uuid;
begin
  if new.event_type not in ('TRIGGERED', 'SNOOZED', 'DISMISSED', 'MISSED', 'WAKE_CONFIRMED') then
    return null;
  end if;
  if new.input_source in ('MANUAL', 'VOICE', 'USAGE') then
    return null;
  end if;

  select a.scheduled_at into v_alarm_at
  from public.alarms a
  where a.alarm_id = new.alarm_id and a.alarm_type = 'WAKE';
  -- 울림 · 미루기 · 해제 · 미확인은 기상 알람 것만 (기상 확인은 알람 종류를 안 봄)
  if new.event_type <> 'WAKE_CONFIRMED' and v_alarm_at is null then
    return null;
  end if;

  select p.timezone into v_tz from public.profiles p where p.user_id = new.user_id;
  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := (coalesce(v_alarm_at, new.event_at) at time zone v_tz)::date;

  for v_group in
    select gm.group_id
    from public.group_members gm
    where gm.user_id = new.user_id
      and gm.invite_status = 'JOINED'
      and gm.wake_share_opt_in      -- D19 결정 전 보수 기본값
      and private.group_wake_has_meeting(gm.group_id, v_date, v_tz)
  loop
    begin
      perform realtime.send(jsonb_build_object('date', v_date), 'refresh', 'group:' || v_group || ':wake', true);
    exception when others then
      raise warning '기상 신호를 보내지 못함 (group %): %', v_group, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 미확인(MISSED) 후보 — 다시 울림 몫을 뺀 식
-- ---------------------------------------------------------------------

-- 지난 정의(batch_notify ⑨)와 같고 달라진 곳: 미확인 시각 = 마지막 울림 시작 + 30분 (확인 알림에 답이 없으면 다시 울리지 않으므로 다시 울림 소요를 더하지 않음, D2)
--   마지막 울림 시작 = 마지막 미루기가 있으면 greatest(알람 시각, 미루기 기록 시각 + 미루기 분), 없으면 알람 시각
--   돌려주는 칸에서 rering_minutes를 뺌(서버 함수 wake-check는 안 씀)
drop function public.find_missed_wake_alarms(timestamptz, integer);

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
  snooze_minutes  integer,       -- 미루기 누적 합 (참고 값 — missed_at은 마지막 미루기 기준)
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
           coalesce(sn.total, 0)::integer as snooze_minutes,
           -- 마지막 울림 묶음이 시작한 때: 마지막 미루기의 다음 울림 (미루기가 없으면 알람 시각)
           greatest(a.scheduled_at, sn.last_ring_at) as last_ring_start
    from public.alarms a
    left join lateral (
      select sum(e.snooze_minutes) as total,
             (array_agg(e.event_at + make_interval(mins => coalesce(e.snooze_minutes, 0))
                        order by e.event_at desc, e.event_id desc))[1] as last_ring_at
      from public.alarm_events e
      where e.alarm_id = a.alarm_id
        and e.event_type = 'SNOOZED'
        and e.event_at >= a.scheduled_at - interval '6 hours'
        and e.event_at <  a.scheduled_at + interval '18 hours'
    ) sn on true
    where a.alarm_type = 'WAKE'
      and a.is_enabled
      and a.scheduled_at <= p_now - interval '30 minutes'
      and a.scheduled_at >  p_now - make_interval(hours => p_lookback_hours)
  ),
  due as (
    select b.*,
           b.last_ring_start + interval '30 minutes' as missed_at
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
      where e.user_id = d.user_id
        and e.event_type = 'WAKE_CONFIRMED'
        and e.event_at >= d.scheduled_at - interval '6 hours'
        and e.event_at <  d.scheduled_at + interval '18 hours')
    and not exists (
      select 1
      from public.alarm_events e
      where e.alarm_id = d.alarm_id
        and e.event_type = 'MISSED'
        and e.event_at >= d.scheduled_at - interval '6 hours')
    and not exists (
      select 1
      from public.daily_records dr
      where dr.user_id = d.user_id
        and dr.wake_confirmed_at >= d.scheduled_at - interval '6 hours'
        and dr.wake_confirmed_at <  d.scheduled_at + interval '18 hours')
  order by d.missed_at, d.alarm_id;
$$;


-- ---------------------------------------------------------------------
-- 7. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function public.set_wake_hidden(uuid, boolean) from public, anon;
revoke execute on function public.get_group_wake(uuid, date) from public, anon;
revoke execute on function private.can_see_wake(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function private.group_wake_has_meeting(uuid, date, text) from public, anon, authenticated;
revoke execute on function private.group_wake_rows(uuid, uuid, date, timestamptz) from public, anon, authenticated;
revoke execute on function private.limit_wake_confirmed_per_day() from public, anon, authenticated;
revoke execute on function private.record_wake_on_confirm() from public, anon, authenticated;
revoke execute on function public.find_missed_wake_alarms(timestamptz, integer) from public, anon, authenticated;

grant execute on function public.set_wake_hidden(uuid, boolean) to authenticated;
grant execute on function public.get_group_wake(uuid, date) to authenticated;
grant execute on function private.can_see_wake(uuid, uuid, uuid) to service_role;
grant execute on function public.find_missed_wake_alarms(timestamptz, integer) to service_role;
