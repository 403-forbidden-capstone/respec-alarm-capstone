-- =====================================================================
-- 친구 2장 — 아이디 · 친구 찾기 (친구 논리설계 2장, 11/8 확정)
--   ① 자동 아이디        가입하면 respec_ + 4자(소문자 · 숫자), 겹치면 다시 만듦. 빈 아이디는 지금 채움
--                        (NOT NULL은 앱 타입 handle: string | null을 S2가 옮긴 뒤 — 그전에도 앱은 트리거 때문에 못 비움)
--   ② 아이디 바꾸기      change_my_handle — 형식 · 소문자 · respec_ 거절 · 30일 1번(자동 아이디 첫 변경 · 온보딩 중은 안 셈)
--                        앱이 handle을 직접 update하는 길, onboarded_at을 비워 30일을 피하는 길은 트리거로 막음 (15-라 중 2장 몫)
--   ③ 아이디 검색        search_by_handle — 공백 · @ · 대소문자 정리, 차단 · 탈퇴 · 온보딩 전은 없는 아이디와 같은 응답, 1분 10회
--                        find_profile_by_handle은 같은 검색을 거치는 옛 모양 (앱이 옮길 때까지, 15장에서 지움)
--   ④ 이름 검색          search_related_by_name — 친구 · 같은 그룹 안 닉네임 부분 일치
--   ⑤ 친구 링크          friend_links + my_friend_link · open_friend_link — 7일 · 여러 명 · 다시 만들면 옛 링크 무효
--   ⑥ 닉네임             앞뒤 공백 떼고 1~30자, 공백만 · 빈 값 거절
--   ⑦ 제한 기록          rate_limit_events (서버 전용 표) + private.take_rate_slot — 3장 요청 · 5장 코드 실패도 같은 표를 씀
-- 새 함수는 상태 값(jsonb status)으로 돌려주고 앱이 문구로 바꿈 (논리설계 공통 규칙 X-7)
-- 차단 판정은 private.is_blocked_pair 한 곳 — 지금은 friends.status = BLOCKED, 4장에서 user_blocks로 바꿈
-- 검색 제한 = 1분 10회 + 하루 100회, 아이디 바꾸기 시도도 같은 횟수에 셈 · 예약어 10개는 정확히 같을 때만 거절 (11/8 지형님, 2-거 · 2-09 · 2-52 · 2-53)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 공용 — 무작위 코드 · 차단 쌍 · 제한 기록
-- ---------------------------------------------------------------------

-- 무작위 글자 p_len개 — 글자마다 gen_random_uuid()의 첫 바이트(강한 난수, pgcrypto 없이) % 글자 수
--   글자표가 32자(256의 약수)면 고르게 나옴. 36자(자동 아이디)는 앞 4글자가 조금 더 자주 나옴(8/256 vs 7/256) — 아이디는 비밀값이 아니라 그대로 씀
--   친구 링크와 5장 그룹 초대 코드가 같은 함수를 씀 (2-바 "그룹 코드 규칙과 같은 함수")
create function private.random_code(p_len integer, p_alphabet text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_n   integer := length(p_alphabet);
  v_out text := '';
begin
  for i in 1 .. p_len loop
    v_out := v_out || substr(p_alphabet, 1 + (get_byte(uuid_send(gen_random_uuid()), 0) % v_n), 1);
  end loop;
  return v_out;
end;
$$;

-- 헷갈리는 글자(0 O 1 I)를 뺀 글자표 32자 — 친구 링크 · 5장 초대 코드 (Q6 · 5-머)
create function private.code_alphabet()
returns text
language sql
immutable
set search_path = ''
as $$ select 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' $$;

-- 자동 아이디 후보 — respec_ + 소문자 · 숫자 4자 (약 168만 가지, 2-사)
create function private.auto_handle()
returns text
language sql
volatile
set search_path = ''
as $$ select 'respec_' || private.random_code(4, 'abcdefghijklmnopqrstuvwxyz0123456789') $$;

-- 앞뒤 공백 떼기 — 스페이스만 떼는 btrim과 달리 탭 · 줄바꿈 · (로캘이 아는) 전각 공백도 뗌. 닉네임 저장 · 가입 닉네임 고르기가 같이 씀
create function private.trim_spaces(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select regexp_replace(p, '^[[:space:]]+|[[:space:]]+$', '', 'g') $$;

-- 두 사람이 차단 쌍인가 (어느 쪽이 걸었든) — 검색 · 링크 · 이름 검색이 같이 씀
--   지금은 friends.status = BLOCKED 행. 4장에서 user_blocks로 바꿀 때 이 함수만 고침
create function private.is_blocked_pair(p_a uuid, p_b uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.friends f
    where f.status = 'BLOCKED'
      and least(f.requester_id, f.addressee_id) = least(p_a, p_b)
      and greatest(f.requester_id, f.addressee_id) = greatest(p_a, p_b)
  );
$$;

-- 제한 기록 — 사람 · 동작마다 한 줄씩. 1분 · 하루 횟수를 셈. 7일 지나면 지움(13장 매일 배치)
--   서버 전용 표: RLS만 켜고 정책 없음 (앱은 못 읽고 못 씀, DB 함수 · service_role만)
create table public.rate_limit_events (
  event_id   bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now(),
  constraint rate_limit_events_action_check check (action in ('HANDLE_SEARCH'))
);
create index idx_rate_limit_events_user_action on public.rate_limit_events (user_id, action, created_at desc);
comment on table public.rate_limit_events is
  '횟수 제한 기록 (친구 2장 검색 · 3장 요청 · 5장 코드 실패). 서버 전용 — 앱은 못 읽음. 7일 보관(13장)';

alter table public.rate_limit_events enable row level security;
revoke all on public.rate_limit_events from anon, authenticated;
grant select, insert, update, delete on public.rate_limit_events to service_role;

-- 한 번 쓸 자리가 있는지 보고, 있으면 기록하고 0 · 없으면 다시 될 때까지 남은 초를 돌려줌
--   1분 p_per_minute번 · 하루 p_per_day번(NULL이면 하루 상한 없음). 하루 = 그 사람 프로필 시간대 0시부터 (X-1)
--   거절된 호출은 기록하지 않음 → 1분 뒤 다시 됨 (2-16)
--   같은 사람 · 같은 동작은 잠금으로 한 줄씩 셈 (폰 · 웹이 동시에 불러도 상한을 못 넘김)
create function private.take_rate_slot(p_uid uuid, p_action text, p_per_minute integer, p_per_day integer default null)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_cnt    integer;
  v_oldest timestamptz;
  v_tz     text;
  v_day0   timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_action || ':' || p_uid::text, 0));

  -- 지난 1분 안의 최근 p_per_minute개 — 다 찼으면 그중 가장 오래된 것이 1분을 벗어날 때 자리가 남
  select count(*), min(t.created_at) into v_cnt, v_oldest
  from (
    select e.created_at from public.rate_limit_events e
    where e.user_id = p_uid and e.action = p_action and e.created_at > now() - interval '1 minute'
    order by e.created_at desc
    limit p_per_minute
  ) t;
  if v_cnt >= p_per_minute then
    return greatest(1, ceil(extract(epoch from (v_oldest + interval '1 minute' - now())))::integer);
  end if;

  if p_per_day is not null then
    select p.timezone into v_tz from public.profiles p where p.user_id = p_uid;
    v_day0 := ((now() at time zone coalesce(v_tz, 'Asia/Seoul'))::date)::timestamp at time zone coalesce(v_tz, 'Asia/Seoul');
    select count(*) into v_cnt from public.rate_limit_events e
    where e.user_id = p_uid and e.action = p_action and e.created_at >= v_day0;
    if v_cnt >= p_per_day then
      return greatest(1, ceil(extract(epoch from (v_day0 + interval '1 day' - now())))::integer);
    end if;
  end if;

  insert into public.rate_limit_events (user_id, action) values (p_uid, p_action);
  return 0;
end;
$$;

-- 검색 결과 · 링크 착지에 같이 쓰는 공개 프로필 모양 (닉네임 · 사진 · 아이디만, X-3)
create function private.public_profile_json(p_uid uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('user_id', p.user_id, 'nickname', p.nickname,
                            'profile_image_url', p.profile_image_url, 'handle', p.handle)
  from public.profiles p where p.user_id = p_uid;
$$;

-- 나(p_me)와 상대(p_other)의 친구 상태 — 같은 그룹 INVITED여도 친구 행이 없으면 NONE (2-더)
create function private.friend_relation(p_me uuid, p_other uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select case
             when f.status = 'ACCEPTED' then 'FRIEND'
             when f.requester_id = p_me then 'REQUEST_SENT'
             else 'REQUEST_RECEIVED'
           end
    from public.friends f
    where f.status in ('PENDING', 'ACCEPTED')
      and least(f.requester_id, f.addressee_id) = least(p_me, p_other)
      and greatest(f.requester_id, f.addressee_id) = greatest(p_me, p_other)
  ), 'NONE');
$$;


-- ---------------------------------------------------------------------
-- 1. 자동 아이디 — 가입 트리거 · 빈 아이디 채우기
-- ---------------------------------------------------------------------

alter table public.profiles
  add column handle_changed_at     timestamptz,
  add column handle_next_change_at timestamptz;

comment on column public.profiles.handle is
  '"@아이디". 가입하면 respec_ + 4자 자동, 바꾸기는 change_my_handle만 (앱 직접 update는 트리거가 막음). 늘 채워져 있음';
comment on column public.profiles.handle_changed_at is
  '본인이 아이디를 직접 바꾼 마지막 시각. NULL = 자동 아이디 그대로 → 친구 탭 "바꿔 보세요" (2-d5)';
comment on column public.profiles.handle_next_change_at is
  '다음에 아이디를 바꿀 수 있는 시각(바꾼 시각 + 30일). NULL = 언제든 — 자동 아이디 첫 변경 · 온보딩 중 변경은 안 셈 (2-아 · 2-카)';

-- 가입하면 프로필 행 + 자동 아이디 — 아이디가 겹치면(유일 색인) 다시 만듦 (2-01 · 2-02 · 2-24)
--   닉네임 고르는 순서는 init_schema 그대로. 후보의 앞뒤 공백은 아래 닉네임 트리거와 같은 trim_spaces로 떼서
--   탭 · 줄바꿈 · 전각 공백뿐인 이름은 다음 후보로 넘어감 (트리거가 ''로 만들어 가입째 실패하지 않게)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_nickname text;
begin
  -- 닉네임은 필수라 메타데이터에 없으면 이메일 앞부분, 그것도 없으면 '사용자'로 채움
  v_nickname := coalesce(
    nullif(private.trim_spaces(v_meta ->> 'nickname'), ''),
    nullif(private.trim_spaces(v_meta ->> 'name'), ''),
    nullif(private.trim_spaces(v_meta ->> 'full_name'), ''),
    nullif(private.trim_spaces(v_meta ->> 'user_name'), ''),
    nullif(private.trim_spaces(v_meta ->> 'preferred_username'), ''),
    nullif(private.trim_spaces(split_part(coalesce(new.email, ''), '@', 1)), ''),
    '사용자'
  );

  for i in 1 .. 20 loop
    begin
      insert into public.profiles (user_id, nickname, profile_image_url, handle)
      values (
        new.id,
        private.trim_spaces(left(v_nickname, 30)),
        coalesce(nullif(v_meta ->> 'avatar_url', ''), nullif(v_meta ->> 'picture', '')),
        private.auto_handle()
      )
      on conflict (user_id) do nothing;
      return new;
    exception when unique_violation then
      null;  -- 아이디가 남과 겹침 → 다시 만듦
    end;
  end loop;
  raise exception '자동 아이디를 만들지 못함 (20번 겹침)';
end;
$$;

-- 지금 아이디가 빈 계정을 한 번에 채움 (2-자 · 2-23) — 겹치면 그 계정만 다시
do $$
declare
  r record;
begin
  for r in select p.user_id from public.profiles p where p.handle is null loop
    loop
      begin
        update public.profiles set handle = private.auto_handle() where user_id = r.user_id;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. 아이디 바꾸기 — change_my_handle · 직접 쓰기 막기
-- ---------------------------------------------------------------------

-- 앱 역할(authenticated · anon)의 직접 update 막기 (15-라 중 2장 몫)
--   ① handle · 변경 시각 칸은 못 바꿈 → change_my_handle로만
--   ② onboarded_at은 비어 있을 때 한 번 채우기만 (온보딩 마지막 단계). 비우거나 바꾸면 30일 예외(온보딩 중)를 다시 얻으므로 막음 (2-아)
--   change_my_handle · dev_reset_my_data(security definer)는 함수 주인 권한으로 돌아 current_user가 앱 역할이 아니라서 통과
--   service_role · 마이그레이션도 통과 (시드 · 운영)
create function private.guard_profile_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.handle is distinct from old.handle
       or new.handle_changed_at is distinct from old.handle_changed_at
       or new.handle_next_change_at is distinct from old.handle_next_change_at then
      raise exception '아이디는 change_my_handle로만 바꿈' using errcode = '42501';
    end if;
    if old.onboarded_at is not null and new.onboarded_at is distinct from old.onboarded_at then
      raise exception '온보딩을 끝낸 시각은 바꿀 수 없음' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_profile_columns
  before update on public.profiles
  for each row execute function private.guard_profile_columns();

-- 내 아이디 바꾸기 — 검사는 여기 한 곳 (2-나 · 2-차)
--   상태: OK · SAME · INVALID · RESERVED · TAKEN · LIMIT. 실패는 예외 대신 상태 값 (X-7)
--   LIMIT은 두 가지: 30일(next_change_at)과 검색 횟수(retry_after_seconds) — 바꾸기 시도도 아이디 검색과 같은 1분 10회 + 하루 100회에 셈.
--   부를 때마다 한 번 셈(TAKEN으로 남이 쓰는 아이디를 계속 알아보는 길을 검색 제한과 같게 막음, 11/8 지형님)
--   30일: 직접 바꾼 적이 있고(handle_changed_at) 온보딩을 끝낸(onboarded_at) 뒤의 변경만 셈.
--         자동 아이디에서 처음 바꾸기 · 온보딩 중 바꾸기는 안 셈 (2-아). 다음 변경 = 바꾼 시각 + 30일, 서버 시각 하나 (2-카)
create function public.change_my_handle(p_handle text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_new    text;
  v_me     record;
  v_counts boolean;
  v_next   timestamptz;
  v_wait   integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  -- 바꾸기 시도도 검색과 같은 횟수에 셈 (2-53). 걸리면 30일 LIMIT과 달리 retry_after_seconds를 돌려줌
  v_wait := private.take_rate_slot(v_uid, 'HANDLE_SEARCH', 10, 100);
  if v_wait > 0 then
    return jsonb_build_object('status', 'LIMIT', 'retry_after_seconds', v_wait);
  end if;

  -- 길이를 먼저 봐서 큰 입력은 다루지 않음 (15-마)
  if p_handle is null or length(p_handle) > 64 then
    return jsonb_build_object('status', 'INVALID');
  end if;
  v_new := lower(ltrim(btrim(p_handle), '@'));
  if v_new !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('status', 'INVALID');
  end if;

  -- 같은 사람이 두 기기에서 동시에 바꾸면 한 줄씩 (2-26)
  select p.handle, p.handle_changed_at, p.handle_next_change_at, p.onboarded_at into v_me
  from public.profiles p where p.user_id = v_uid
  for update;
  if not found then
    raise exception '프로필이 없음' using errcode = '42501';
  end if;

  -- 지금 아이디 그대로(자동 아이디 포함)면 바꾸지 않고 SAME — respec_ 검사보다 먼저 (온보딩 [다음]이 자동 아이디를 그대로 보내도 됨)
  if v_me.handle = v_new then
    return jsonb_build_object('status', 'SAME', 'handle', v_new, 'next_change_at', v_me.handle_next_change_at);
  end if;
  -- 자동 아이디 모양(respec_…)과 예약어 10개는 사칭이라 거절. 예약어는 정확히 같을 때만(admin1은 통과, 2-09)
  if left(v_new, 7) = 'respec_'
     or v_new = any (array['admin', 'respec', 'support', 'help', 'official', 'system', 'root', 'operator', 'manager', 'null']) then
    return jsonb_build_object('status', 'RESERVED');
  end if;

  if v_me.onboarded_at is not null and v_me.handle_next_change_at is not null and now() < v_me.handle_next_change_at then
    return jsonb_build_object('status', 'LIMIT', 'next_change_at', v_me.handle_next_change_at);
  end if;

  v_counts := v_me.handle_changed_at is not null and v_me.onboarded_at is not null;
  v_next := case when v_counts then now() + interval '30 days' end;

  begin
    update public.profiles
    set handle = v_new, handle_changed_at = now(), handle_next_change_at = v_next
    where user_id = v_uid;
  exception when unique_violation then
    return jsonb_build_object('status', 'TAKEN');   -- 남이 쓰는 아이디 (2-07). 옛 아이디는 바로 풀림 (2-08)
  end;

  return jsonb_build_object('status', 'OK', 'handle', v_new, 'next_change_at', v_next);
end;
$$;


-- ---------------------------------------------------------------------
-- 3. 아이디 검색 — search_by_handle (+ 옛 모양 find_profile_by_handle)
-- ---------------------------------------------------------------------

-- 아이디 정확 일치로 사람 찾기 (D64 #7)
--   상태: FOUND(profile · relation) · SELF(profile) · NOT_FOUND · LIMIT(retry_after_seconds)
--   NOT_FOUND = 없는 아이디 · 탈퇴 · 차단(어느 쪽이든) · 온보딩 전 — 응답 모양까지 같음 (2-라 · 2-34 · 2-너)
--   제한: 1분 10회 + 하루 100회(프로필 시간대 0시부터), 성공 · 실패 모두 셈, 사람 단위, 아이디 바꾸기 시도와 합쳐서 (2-거 · 2-52 · 2-53). 걸리면 누구를 찾든 같은 LIMIT
create function public.search_by_handle(p_query text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_wait  integer;
  v_q     text;
  v_other record;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  v_wait := private.take_rate_slot(v_uid, 'HANDLE_SEARCH', 10, 100);
  if v_wait > 0 then
    return jsonb_build_object('status', 'LIMIT', 'retry_after_seconds', v_wait);
  end if;

  -- 길이 · 형식 먼저 (15-마). 앞뒤 공백 · 맨 앞 @ · 대소문자 정리, 전각은 형식에 안 맞아 못 찾음 (2-하 · 2-31)
  if p_query is null or length(p_query) > 64 then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  v_q := lower(ltrim(btrim(p_query), '@'));
  if v_q !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select p.user_id, p.onboarded_at into v_other
  from public.profiles p where lower(p.handle) = v_q;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_other.user_id = v_uid then
    return jsonb_build_object('status', 'SELF', 'profile', private.public_profile_json(v_uid));
  end if;
  if v_other.onboarded_at is null or private.is_blocked_pair(v_uid, v_other.user_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  return jsonb_build_object('status', 'FOUND',
                            'profile', private.public_profile_json(v_other.user_id),
                            'relation', private.friend_relation(v_uid, v_other.user_id));
end;
$$;

-- 옛 모양 — 앱(친구 검색 · 온보딩 아이디 확인)이 search_by_handle로 옮길 때까지 둠. 같은 검색 · 같은 제한을 거침
--   FOUND · SELF면 공개 4칸 한 행, 나머지(NOT_FOUND · LIMIT)는 빈 결과. 15장에서 지움
create or replace function public.find_profile_by_handle(p_handle text)
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb := public.search_by_handle(p_handle);
begin
  if v ->> 'status' in ('FOUND', 'SELF') then
    return query
      select (v -> 'profile' ->> 'user_id')::uuid,
             (v -> 'profile' ->> 'nickname')::varchar,
             v -> 'profile' ->> 'profile_image_url',
             v -> 'profile' ->> 'handle';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 이름 검색 — search_related_by_name
-- ---------------------------------------------------------------------

-- 친구(수락됨) · 같은 그룹(둘 다 참여 중) 안에서만 닉네임 부분 일치 (2-가 · D64 #7)
--   나 · 차단 쌍은 뺌, 탈퇴한 사람은 행이 없어 자연히 빠짐 (2-47). 동명이인은 handle로 구분 (2-파)
--   검색어는 앞뒤 공백 뗀 1~30자, 아니면 빈 결과. % · _ · \는 글자 그대로 찾음
create function public.search_related_by_name(p_query text)
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text, relation text)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid,
           btrim(coalesce(p_query, '')) as q
  ),
  related as (
    select case when f.requester_id = m.uid then f.addressee_id else f.requester_id end as user_id,
           'FRIEND'::text as relation
    from public.friends f
    join me m on m.uid in (f.requester_id, f.addressee_id)
    where f.status = 'ACCEPTED'
    union
    select other.user_id, 'GROUP'::text
    from public.group_members mine
    join me m on m.uid = mine.user_id
    join public.group_members other on other.group_id = mine.group_id
    where mine.invite_status = 'JOINED' and other.invite_status = 'JOINED' and other.user_id <> m.uid
  ),
  best as (
    -- 친구이면서 같은 그룹이면 FRIEND 한 줄
    select r.user_id, min(r.relation) as relation   -- 'FRIEND' < 'GROUP'
    from related r group by r.user_id
  )
  select p.user_id, p.nickname, p.profile_image_url, p.handle, b.relation
  from best b
  join public.profiles p on p.user_id = b.user_id
  cross join me m
  where m.uid is not null
    and char_length(m.q) between 1 and 30
    and p.nickname ilike '%' || replace(replace(replace(m.q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and not private.is_blocked_pair(m.uid, p.user_id)
  order by p.nickname, p.handle;
$$;


-- ---------------------------------------------------------------------
-- 5. 친구 링크 — friend_links · my_friend_link · open_friend_link
-- ---------------------------------------------------------------------

-- 한 사람 링크 하나 (다시 만들면 행을 바꿔 옛 토큰은 바로 무효, 2-바). 7일. 여러 명이 같은 링크를 씀
--   서버 전용 표: 앱은 함수로만
create table public.friend_links (
  owner_id   uuid primary key references public.profiles (user_id) on delete cascade,
  token      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint friend_links_token_key unique (token),
  constraint friend_links_token_format check (token ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$')
);
comment on table public.friend_links is
  '친구 링크 (친구 2장). 한 사람 하나, 7일, 다시 만들면 옛 토큰 무효. 서버 전용 — my_friend_link · open_friend_link로만';

alter table public.friend_links enable row level security;
revoke all on public.friend_links from anon, authenticated;
grant select, insert, update, delete on public.friend_links to service_role;

-- 내 친구 링크 — 있고 안 지났으면 그대로, 없거나 지났거나 p_renew면 새 토큰 + 7일
create function public.my_friend_link(p_renew boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_link record;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  -- 폰 · 웹이 처음에 동시에 불러도 한 줄씩 (행이 없으면 for update가 잠글 게 없어 뒤 호출이 앞 토큰을 덮어씀)
  perform pg_advisory_xact_lock(hashtextextended('friend_link:' || v_uid::text, 0));

  select l.token, l.expires_at into v_link
  from public.friend_links l where l.owner_id = v_uid
  for update;

  if found and not coalesce(p_renew, false) and v_link.expires_at > now() then
    return jsonb_build_object('token', v_link.token, 'expires_at', v_link.expires_at);
  end if;

  for i in 1 .. 20 loop
    begin
      insert into public.friend_links as l (owner_id, token, created_at, expires_at)
      values (v_uid, private.random_code(12, private.code_alphabet()), now(), now() + interval '7 days')
      on conflict (owner_id) do update
        set token = excluded.token, created_at = excluded.created_at, expires_at = excluded.expires_at
      returning l.token, l.expires_at into v_link;
      return jsonb_build_object('token', v_link.token, 'expires_at', v_link.expires_at);
    exception when unique_violation then
      null;  -- 토큰이 남과 겹침 → 다시
    end;
  end loop;
  raise exception '링크를 만들지 못함';
end;
$$;

-- 친구 링크 착지 — 요청은 안 보냄(화면 [친구 요청]을 눌러야 3장 요청 함수로, 2-19 · 2-51)
--   상태: OK(profile · relation) · SELF(profile) · EXPIRED
--   EXPIRED = 없는 · 옛(다시 만든) · 7일 지난 · 주인 탈퇴 · 차단 쌍 · 주인 온보딩 전 — 모두 같은 응답 (2-21 · 2-40 · 2-41 · 2-42)
create function public.open_friend_link(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_t     text;
  v_owner record;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  if p_token is null or length(p_token) > 64 then
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  v_t := upper(btrim(p_token));

  select l.owner_id, p.onboarded_at into v_owner
  from public.friend_links l
  join public.profiles p on p.user_id = l.owner_id
  where l.token = v_t and l.expires_at > now();

  if not found then
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  if v_owner.owner_id = v_uid then
    return jsonb_build_object('status', 'SELF', 'profile', private.public_profile_json(v_uid));
  end if;
  if v_owner.onboarded_at is null or private.is_blocked_pair(v_uid, v_owner.owner_id) then
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  return jsonb_build_object('status', 'OK',
                            'profile', private.public_profile_json(v_owner.owner_id),
                            'relation', private.friend_relation(v_uid, v_owner.owner_id));
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 닉네임 — 앞뒤 공백 떼고 1~30자 (2-파 · 2-28)
-- ---------------------------------------------------------------------

-- 저장할 때 앞뒤 공백(탭 · 줄바꿈 포함)을 뗌
create function private.trim_profile_nickname()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- private.trim_spaces와 같은 식 (이 트리거는 앱 역할 권한으로 돌아 private 함수를 부르지 않음)
  new.nickname := regexp_replace(new.nickname, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  return new;
end;
$$;

create trigger trim_profile_nickname
  before insert or update of nickname on public.profiles
  for each row execute function private.trim_profile_nickname();

-- 지금 값도 맞춤 — 공백만이던 닉네임은 '사용자'
update public.profiles
set nickname = coalesce(nullif(regexp_replace(nickname, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), '사용자')
where nickname ~ '^[[:space:]]|[[:space:]]$' or nickname = '';

alter table public.profiles
  add constraint profiles_nickname_trimmed check (char_length(nickname) >= 1 and nickname !~ '^[[:space:]]|[[:space:]]$');


-- ---------------------------------------------------------------------
-- 7. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function
  private.random_code(integer, text),
  private.code_alphabet(),
  private.auto_handle(),
  private.is_blocked_pair(uuid, uuid),
  private.take_rate_slot(uuid, text, integer, integer),
  private.public_profile_json(uuid),
  private.friend_relation(uuid, uuid),
  private.trim_spaces(text),
  private.guard_profile_columns(),
  private.trim_profile_nickname()
from public, anon, authenticated;

revoke execute on function
  public.change_my_handle(text),
  public.search_by_handle(text),
  public.find_profile_by_handle(text),
  public.search_related_by_name(text),
  public.my_friend_link(boolean),
  public.open_friend_link(text)
from public, anon;

grant execute on function
  public.change_my_handle(text),
  public.search_by_handle(text),
  public.find_profile_by_handle(text),
  public.search_related_by_name(text),
  public.my_friend_link(boolean),
  public.open_friend_link(text)
to authenticated;
