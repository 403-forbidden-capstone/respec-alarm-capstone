-- =====================================================================
-- 목업 보완 5개 — 목업 화면에 필요한데 4장 15개 테이블에 없는 것 (DB 담당 결정, 10/6)
--   ① profiles.handle        "@아이디" 친구 검색용 고유 아이디 + find_profile_by_handle()
--   ② groups.invite_code     그룹 참여 초대 코드 + join_group_by_invite_code() · regenerate_invite_code()
--   ③ get_group_wake_status  그룹원 오늘 기상 상태 조회 (기상 공유를 허용한 사람만)
--   ④ push_tokens            기기 푸시 토큰 + register_push_token()  (2장 R-1)
--   ⑤ ACKNOWLEDGED           alarm_event_type 값 추가 — 알림 원탭 응답  (2장 R-3)
-- RLS · 실행 권한은 20261007000200_rls.sql에서 같이 정함
-- =====================================================================


-- ---------------------------------------------------------------------
-- ① "@아이디" — 온보딩에서 정하므로 그전까지는 비어 있음
-- ---------------------------------------------------------------------

alter table public.profiles
  add column handle text,
  add constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,20}$');

-- 대소문자와 상관없이 한 사람만 쓰게 함
create unique index profiles_handle_key on public.profiles (lower(handle));

-- 아이디로 사람 찾기 — 친구가 아니어도 정확히 맞는 한 명의 공개 정보(닉네임 · 사진 · 아이디)만 돌려줌
-- profiles RLS가 본인 행만 보여 주므로 함수로 처리함. 차단 관계면 안 보여 줌
create function public.find_profile_by_handle(p_handle text)
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.nickname, p.profile_image_url, p.handle
  from public.profiles p
  where (select auth.uid()) is not null
    and lower(p.handle) = lower(ltrim(btrim(p_handle), '@'))
    and not exists (
      select 1
      from public.friends f
      where f.status = 'BLOCKED'
        and ((f.requester_id = p.user_id and f.addressee_id = (select auth.uid()))
          or (f.requester_id = (select auth.uid()) and f.addressee_id = p.user_id))
    );
$$;


-- ---------------------------------------------------------------------
-- ② 그룹 초대 코드 — 그룹을 만들면 8자리 코드가 자동으로 들어감
-- ---------------------------------------------------------------------

alter table public.groups
  add column invite_code text not null default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  add constraint groups_invite_code_format check (invite_code ~ '^[A-Z0-9]{6,12}$'),
  add constraint groups_invite_code_key unique (invite_code);

-- 초대 코드로 그룹 참여 — 초대받은 상태(INVITED)면 수락, 나갔던 사람(LEFT)이면 다시 참여시킴
-- RLS상 남의 그룹은 안 보이므로 코드 확인을 함수 안에서 함. 참여한 그룹 id를 돌려줌
create function public.join_group_by_invite_code(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  select g.group_id into v_group_id
  from public.groups g
  where g.invite_code = upper(btrim(p_invite_code));

  if v_group_id is null then
    raise exception '초대 코드가 맞지 않음';
  end if;

  -- 다시 참여하면 기상 공유 동의는 꺼진 상태로 시작함
  insert into public.group_members as gm (group_id, user_id, invite_status, joined_at)
  values (v_group_id, v_uid, 'JOINED', now())
  on conflict (group_id, user_id) do update
    set invite_status     = 'JOINED',
        joined_at         = case when gm.invite_status = 'JOINED' then gm.joined_at else now() end,
        wake_share_opt_in = case when gm.invite_status = 'LEFT' then false else gm.wake_share_opt_in end;

  return v_group_id;
end;
$$;

-- 초대 코드 새로 받기 — 만든 사람만 쓸 수 있고 새 코드를 돌려줌. 옛 코드는 바로 못 씀
-- 만든 사람이 구성원을 내보내면 rls 마이그레이션의 트리거가 같은 방식으로 코드를 자동으로 바꿈
create function public.regenerate_invite_code(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  update public.groups g
  set invite_code = default
  where g.group_id = p_group_id
    and g.owner_id = (select auth.uid())
  returning g.invite_code into v_code;

  if v_code is null then
    raise exception '그룹을 만든 사람만 초대 코드를 바꿀 수 있음' using errcode = '42501';
  end if;

  return v_code;
end;
$$;


-- ---------------------------------------------------------------------
-- ③ 그룹원 오늘 기상 상태 — 그룹 상세(G02) · 그룹원 기상(G03) 화면용
-- ---------------------------------------------------------------------
-- 호출자가 이 그룹에 참여 중(JOINED)일 때만 결과가 있음
-- 본인 행은 항상, 다른 구성원은 호출자에게 기상 조회 권한이 있을 때만 나옴
--   권한 = 친구 권한 ∪ 그룹 권한 (그룹 권한은 그 그룹에서 기상 공유에 동의했을 때만 인정, 4.6 · 2장 R-11)
--   판정은 rls 마이그레이션의 private.granted_owner_ids()를 씀 — plpgsql은 실행할 때 함수를 찾으므로 파일 순서 문제 없음
-- 기상 관련 값만 돌려줌 (준비 · 출발 · 도착 결과는 4.6에서 본인만 보므로 뺌)
-- p_date를 안 주면 호출자 시간대(profiles.timezone) 기준 오늘
--   DB 기본 시간대는 UTC라 current_date를 쓰면 한국 아침 9시 전에는 어제 날짜가 됨
create function public.get_group_wake_status(p_group_id uuid, p_date date default null)
returns table (
  user_id           uuid,
  nickname          varchar,
  profile_image_url text,
  is_me             boolean,
  wake_alarm_at     timestamptz,   -- 그날 첫 기상 알람 시각
  rang_at           timestamptz,   -- 기상 알람이 처음 울린 시각
  snooze_count      integer,       -- 미루기 횟수
  dismissed_at      timestamptz,   -- 알람 해제 시각 (기상 확인 아님, 4.7)
  wake_confirmed_at timestamptz,   -- 기상 확인 시각
  missed_at         timestamptz,   -- 기상 확인 없이 놓친 시각
  wake_status       text           -- CONFIRMED · MISSED · DISMISSED · RINGING · SCHEDULED · NO_ALARM
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_tz   text;
  v_date date;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if v_uid is null or not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = v_uid
      and gm.invite_status = 'JOINED'
  ) then
    return;
  end if;

  select p.timezone into v_tz
  from public.profiles p
  where p.user_id = v_uid;

  v_tz   := coalesce(v_tz, 'Asia/Seoul');
  v_date := coalesce(p_date, (now() at time zone v_tz)::date);
  v_from := v_date::timestamp at time zone v_tz;
  v_to   := (v_date + 1)::timestamp at time zone v_tz;

  return query
  with members as (
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.invite_status = 'JOINED'
      and (gm.user_id = v_uid
           or gm.user_id in (select private.granted_owner_ids('VIEW_WAKE')))
  ),
  wake_alarms as (
    select a.user_id, min(a.scheduled_at) as first_at
    from public.alarms a
    where a.user_id in (select m.user_id from members m)
      and a.alarm_type = 'WAKE'
      and a.is_enabled
      and a.scheduled_at >= v_from
      and a.scheduled_at <  v_to
    group by a.user_id
  ),
  wake_events as (
    select e.user_id,
           min(e.event_at) filter (where e.event_type = 'TRIGGERED' and a.alarm_type = 'WAKE') as rang_at,
           count(*)        filter (where e.event_type = 'SNOOZED'   and a.alarm_type = 'WAKE') as snoozes,
           min(e.event_at) filter (where e.event_type = 'DISMISSED' and a.alarm_type = 'WAKE') as dismissed_at,
           min(e.event_at) filter (where e.event_type = 'WAKE_CONFIRMED')                      as confirmed_at,
           min(e.event_at) filter (where e.event_type = 'MISSED'    and a.alarm_type = 'WAKE') as missed_at
    from public.alarm_events e
    join public.alarms a on a.alarm_id = e.alarm_id
    where e.user_id in (select m.user_id from members m)
      and e.event_at >= v_from
      and e.event_at <  v_to
    group by e.user_id
  ),
  merged as (
    -- 알람이 울린 뒤 다음 회차로 옮겨졌으면 첫 울림 시각을 알람 시각으로 씀
    -- 기상 확인은 이벤트가 없으면 daily_records 값을 씀
    select m.user_id,
           coalesce(wa.first_at, we.rang_at)               as alarm_at,
           we.rang_at,
           coalesce(we.snoozes, 0)::integer                as snoozes,
           we.dismissed_at,
           coalesce(we.confirmed_at, dr.wake_confirmed_at) as confirmed_at,
           we.missed_at
    from members m
    left join wake_alarms wa on wa.user_id = m.user_id
    left join wake_events we on we.user_id = m.user_id
    left join public.daily_records dr on dr.user_id = m.user_id and dr.record_date = v_date
  )
  select x.user_id,
         p.nickname,
         p.profile_image_url,
         x.user_id = v_uid,
         x.alarm_at,
         x.rang_at,
         x.snoozes,
         x.dismissed_at,
         x.confirmed_at,
         x.missed_at,
         case
           when x.confirmed_at is not null then 'CONFIRMED'
           when x.missed_at    is not null then 'MISSED'
           when x.dismissed_at is not null then 'DISMISSED'
           when x.rang_at      is not null then 'RINGING'
           when x.alarm_at     is not null then 'SCHEDULED'
           else 'NO_ALARM'
         end
  from merged x
  join public.profiles p on p.user_id = x.user_id
  order by x.user_id = v_uid desc, p.nickname;
end;
$$;


-- ---------------------------------------------------------------------
-- ④ 기기 푸시 토큰 — 그룹 알림 · 출발 시각 변경 알림을 원격으로 보낼 대상 (2장 R-1)
-- ---------------------------------------------------------------------

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  token        text not null,                                         -- Expo 푸시 토큰
  platform     text not null default 'android',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),                    -- 앱이 마지막으로 등록한 시각 (오래된 토큰 정리 기준)
  constraint push_tokens_token_key unique (token),
  constraint push_tokens_platform_check check (platform in ('android', 'ios', 'web'))
);

create index idx_push_tokens_user on public.push_tokens (user_id);

comment on table public.push_tokens is '기기 푸시 토큰 (목업 보완)';

-- 토큰 등록 · 갱신 — 앱을 켤 때마다 부름. 같은 폰에서 다른 계정으로 로그인했으면 토큰 주인을 지금 사용자로 바꿈
-- (본인 행만 고칠 수 있는 RLS로는 다른 계정에 남은 토큰을 가져올 수 없어 함수로 처리함)
create function public.register_push_token(p_token text, p_platform text default 'android')
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

  insert into public.push_tokens (user_id, token, platform)
  values (v_uid, p_token, p_platform)
  on conflict (token) do update
    set user_id      = excluded.user_id,
        platform     = excluded.platform,
        last_seen_at = now();
end;
$$;


-- ---------------------------------------------------------------------
-- ⑤ 알림 원탭 응답 — 준비 시작 · 출발 · 루틴 단계 알림에 "예"를 누른 기록 (2장 R-3)
-- ---------------------------------------------------------------------
-- 새 ENUM 값은 이 마이그레이션이 끝나야 쓸 수 있으므로 이 파일에서는 쓰지 않음

alter type public.alarm_event_type add value if not exists 'ACKNOWLEDGED';
