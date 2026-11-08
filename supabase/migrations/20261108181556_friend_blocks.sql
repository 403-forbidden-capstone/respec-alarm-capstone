-- =====================================================================
-- 친구 4장 — 차단 · 신고 (친구 논리설계 4장, 11/8 확정)
--   ① 차단 표 user_blocks (행은 사람마다, 효과는 양쪽, 풀기는 자기 행만) + 기존 BLOCKED 친구 행 옮기기 (4-사)
--   ② block_user · unblock_user · my_blocks — 누구나 차단, 친구 끊김 + 대기 요청 삭제 + 두 사람 사이 권한 삭제 (4-마 · 4-바 · 4-아)
--   ③ 차단 판정 한 곳: private.is_blocked_pair를 user_blocks로. 권한 판정(is_valid_permission_source) · 직접 요청 insert ·
--      공개 프로필 함수 · 푸시 판정(can_send_push)에 차단을 더함 (4-나 · 4-라 · 4-하)
--   ④ 신고 표 reports + submit_report (같은 대상 하루 1번, X-10 · 4-마)
-- 빈 곳(문서 보충 대기): 운영 화면용 신고 조회 · 처리 함수 — "팀원 계정만"을 DB가 가리는 방법이 문서에 없음 → 이 파일엔 신고 넣기까지
-- 4-17(내보내기 알림 없음) · 4-18(코드 미리보기)는 5장, FRIEND_* 푸시 4-16 · 변경 알림 문구 4-35는 11장
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 차단 표 — 읽기는 차단한 사람 본인만, 쓰기는 DB 함수로만
-- ---------------------------------------------------------------------

create table public.user_blocks (
  blocker_id uuid not null references public.profiles (user_id) on delete cascade,   -- 차단한 사람
  blocked_id uuid not null references public.profiles (user_id) on delete cascade,   -- 차단당한 사람 (탈퇴하면 같이 지워짐, 4-26)
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_no_self check (blocker_id <> blocked_id)
);

-- 차단당한 쪽 기준 조회(차단 쌍 판정 · 탈퇴 연쇄 삭제)
create index idx_user_blocks_blocked on public.user_blocks (blocked_id);

comment on table public.user_blocks is '차단 — 행은 사람마다, 효과는 양쪽 (친구 4장). 차단한 사람만 읽고, 쓰기는 block_user · unblock_user로만';

alter table public.user_blocks enable row level security;

create policy user_blocks_select_blocker on public.user_blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

-- 읽기만 열고 넣기 · 고치기 · 지우기는 막음(차단당한 사람이 알 수 없고, 앱이 직접 조작하지 못하게)
revoke all on public.user_blocks from anon, authenticated;
grant select on public.user_blocks to authenticated;
grant select, insert, update, delete on public.user_blocks to service_role;


-- ---------------------------------------------------------------------
-- 2. 기존 BLOCKED 친구 행 옮기기 (4-사)
-- ---------------------------------------------------------------------

-- 받은 쪽(addressee) = 차단한 사람. 옮기고 friends 행은 지움(행을 지우면 그 친구 출처 권한 행도 지금 트리거가 지움)
insert into public.user_blocks (blocker_id, blocked_id, created_at)
select f.addressee_id, f.requester_id, f.requested_at
from public.friends f
where f.status = 'BLOCKED'
on conflict do nothing;

delete from public.friends f where f.status = 'BLOCKED';

-- 옮긴 쌍 사이에 남은 공유 권한(그룹 출처 포함)도 지움 — 친구 행을 지우는 트리거는 친구 출처 권한만 지우고, 남겨 두면 풀 때 되살아남(4-21)
delete from public.sharing_permissions sp
using public.user_blocks b
where (sp.owner_id = b.blocker_id and sp.grantee_id = b.blocked_id)
   or (sp.owner_id = b.blocked_id and sp.grantee_id = b.blocker_id);

-- 3장부터 친구 상태는 대기 → 친구로만 바뀌어 "친구 → 다른 상태" 때 권한을 지우던 트리거는 더는 닿지 않음
drop trigger if exists revoke_permissions_on_change on public.friends;


-- ---------------------------------------------------------------------
-- 3. 차단 판정 — 한 곳
-- ---------------------------------------------------------------------

-- 두 사람이 차단 쌍인가 (어느 쪽이 걸었든). 2장의 검색 · 링크 · 이름 검색, 3장의 요청이 이미 이 함수를 씀
create or replace function private.is_blocked_pair(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;

-- 권한 행의 출처가 살아 있는지 — 차단 쌍이면 출처가 있어도 권한은 끝난 것 (4-나 · 4-d2)
--   알람 조회 · 설정 · 기상 조회(get_group_wake_status · 알람 RLS · can_send_push)와 권한 행 만들기(RLS)가 모두 이 함수를 거치므로
--   차단한 뒤 권한 행이 다시 생겨도(예전 값이 되살아나도) 효과가 없음
create or replace function private.is_valid_permission_source(
  p_owner_id    uuid,
  p_grantee_id  uuid,
  p_source_type public.permission_source,
  p_source_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.is_blocked_pair(p_owner_id, p_grantee_id)
    and case p_source_type
      when 'FRIEND' then exists (
        select 1
        from public.friends f
        where f.friend_id = p_source_id
          and f.status = 'ACCEPTED'
          and ((f.requester_id = p_owner_id and f.addressee_id = p_grantee_id)
            or (f.requester_id = p_grantee_id and f.addressee_id = p_owner_id))
      )
      when 'GROUP' then (
        select count(*) = 2
        from public.group_members gm
        where gm.group_id = p_source_id
          and gm.user_id in (p_owner_id, p_grantee_id)
          and gm.invite_status = 'JOINED'
      )
      else false
    end;
$$;

-- 앱이 friends에 직접 요청 행을 넣는 길(15장에서 닫기 전까지)도 차단 쌍이면 거절 (4-04)
--   앱 역할(authenticated · anon)만 — 시드 · 서버(service_role)는 그대로. 없는 사람을 넣을 때의 외래 키 위반(23503)과 코드 · 메시지 · 상세까지 같은 모양으로 거절해
--   차단당했음이 드러나지 않게 하고(4-가), 앱의 기존 문구 처리(23503 = '사용자를 찾을 수 없어요')도 그대로 탐
--   차단(block_user)과 겹치면 가드가 아직 커밋 안 된 차단을 못 보고 대기 행이 남던 경쟁을 막으려고 같은 사람 잠금(3장)을 먼저 걸어 차단이 끝나길 기다림
--   definer 함수 안에서는 current_user가 소유자라 호출한 역할은 role 설정으로 봄
create function private.guard_friend_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('role', true) in ('authenticated', 'anon') then
    perform private.lock_friend_pair(new.requester_id, new.addressee_id);
    if private.is_blocked_pair(new.requester_id, new.addressee_id) then
      raise exception 'insert or update on table "friends" violates foreign key constraint "friends_addressee_id_fkey"'
        using errcode = '23503', schema = 'public', table = 'friends', constraint = 'friends_addressee_id_fkey',
              detail = 'Key is not present in table "profiles".';   -- 앱 역할은 키 값을 읽을 권한이 없어 없는 사람일 때도 이 모양
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_friend_insert
  before insert on public.friends
  for each row execute function private.guard_friend_insert();

-- 푸시를 보내도 되는지 — 보내는 순간 차단을 다시 확인 (4-하). 차단 직전에 잡혀 있던 알림도 여기서 걸림
--   나머지는 그대로(ALARM_CHANGED는 설정 권한, 그 밖의 종류는 거절). 권한 판정이 차단을 이미 보지만 한 겹 더 둠
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
      -- when 'WAKE_PING' then ... D19 결정 뒤
      else false
    end
  end;
$$;

-- 공개 프로필 — 차단 쌍이 같은 그룹이면 서로 닉네임만(사진 · 아이디 없음) (4-나 · 4-차 · 4-d2)
--   보이는 사람 범위는 그대로(나 · 친구 · 같은 그룹), 차단 쌍의 값만 가림. 차단한 사람 · 당한 사람 모두 같은 모습
create or replace function public.get_public_profiles(p_user_ids uuid[] default null)
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid
  ),
  related as (
    select m.uid as user_id
    from me m
    where m.uid is not null
    union
    select case when f.requester_id = m.uid then f.addressee_id else f.requester_id end
    from public.friends f
    join me m on m.uid in (f.requester_id, f.addressee_id)
    where f.status <> 'BLOCKED'
    union
    select other.user_id
    from public.group_members mine
    join me m on m.uid = mine.user_id
    join public.group_members other on other.group_id = mine.group_id
    where mine.invite_status in ('INVITED', 'JOINED')
      and other.invite_status in ('INVITED', 'JOINED')
  )
  select p.user_id,
         p.nickname,
         case when private.is_blocked_pair((select uid from me), p.user_id) then null else p.profile_image_url end,
         case when private.is_blocked_pair((select uid from me), p.user_id) then null else p.handle end
  from public.profiles p
  join related r on r.user_id = p.user_id
  where p_user_ids is null or p.user_id = any (p_user_ids);
$$;


-- ---------------------------------------------------------------------
-- 4. 차단 · 풀기 · 목록
-- ---------------------------------------------------------------------

-- 차단 — 누구나(친구 · 검색 결과 · 요청 보낸 사람 · 같은 그룹원, 4-마). 횟수 제한 없음 (4-29)
--   상태: BLOCKED · ALREADY_BLOCKED(행 그대로) · SELF · NOT_FOUND(없는 사람 · 탈퇴)
--   하는 일: 차단 행 1개 + 두 사람 사이 친구 / 대기 행(어느 방향이든) 삭제 + 두 사람 사이 공유 권한(친구 · 그룹 출처 모두) 삭제.
--   상대가 바꿔 둔 내 알람 · 공동 약속 참여 · 그룹 구성원 자격은 그대로 (4-너), 알림 없음
create function public.block_user(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_new integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_user_id is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_user_id = v_uid then
    return jsonb_build_object('status', 'SELF');
  end if;

  -- 같은 두 사람의 요청 · 수락과 한 줄씩 (3장 쌍 잠금) — 맞요청 중에 차단해도 자동 수락이 안 되게 (4-08)
  perform private.lock_friend_pair(v_uid, p_user_id);

  if not exists (select 1 from public.profiles p where p.user_id = p_user_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, p_user_id) on conflict do nothing;
  get diagnostics v_new = row_count;

  -- 이미 차단한 사이여도 남은 것이 있으면 같이 정리함(멱등)
  delete from public.friends f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_user_id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user_id);
  delete from public.sharing_permissions sp
  where (sp.owner_id = v_uid and sp.grantee_id = p_user_id)
     or (sp.owner_id = p_user_id and sp.grantee_id = v_uid);

  return jsonb_build_object('status', case when v_new > 0 then 'BLOCKED' else 'ALREADY_BLOCKED' end);
end;
$$;

-- 차단 풀기 — 내 행만 지움. 상대가 나를 차단한 행은 남음 (4-바). 친구 · 권한은 복구 안 됨, 새 요청부터 (4-21)
--   상태: UNBLOCKED · GONE(차단한 적 없는 사람)
create function public.unblock_user(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_had boolean;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  delete from public.user_blocks b where b.blocker_id = v_uid and b.blocked_id = p_user_id;
  v_had := found;
  if v_had then
    -- 차단 중에 어떤 길로든 생긴 권한 행이 풀리는 순간 되살아나지 않게 지움 (4-21)
    delete from public.sharing_permissions sp
    where (sp.owner_id = v_uid and sp.grantee_id = p_user_id) or (sp.owner_id = p_user_id and sp.grantee_id = v_uid);
  end if;
  return jsonb_build_object('status', case when v_had then 'UNBLOCKED' else 'GONE' end);
end;
$$;

-- 설정 > 차단 목록 — 내가 건 사람만(상대가 나를 차단했는지는 안 보임), 새로 건 순서. 탈퇴한 사람은 행이 없고 아이디를 바꾸면 새 아이디 (4-다 · 4-자)
--   로그인 정보가 없으면 빈 결과 (이름 검색과 같게)
create function public.my_blocks()
returns table (user_id uuid, nickname varchar, profile_image_url text, handle text, blocked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.nickname, p.profile_image_url, p.handle, b.created_at
  from public.user_blocks b
  join public.profiles p on p.user_id = b.blocked_id
  where b.blocker_id = (select auth.uid())
  order by b.created_at desc, p.nickname, p.user_id;
$$;


-- ---------------------------------------------------------------------
-- 5. 신고 — 신고 표 + 넣기 함수
-- ---------------------------------------------------------------------

-- 서버 전용: 앱은 읽지도 쓰지도 못하고(신고당한 사람이 알 수 없게), 넣기는 submit_report로만. 읽기 · 처리는 운영 화면 몫(빈 곳)
create table public.reports (
  report_id       uuid primary key default gen_random_uuid(),
  reporter_id     uuid references public.profiles (user_id) on delete set null,   -- 신고한 사람이 탈퇴해도 신고 내용은 남김
  target_type     text not null check (target_type in ('USER', 'GROUP')),
  target_user_id  uuid references public.profiles (user_id) on delete cascade,    -- 신고당한 사람이 탈퇴하면 같이 지워짐
  target_group_id uuid references public.groups (group_id) on delete cascade,
  reason          text not null check (reason in ('HARASSMENT', 'NICKNAME', 'PHOTO', 'GROUP_NAME', 'OTHER')),
  note            text check (note is null or char_length(note) between 1 and 200),
  status          text not null default 'OPEN' check (status in ('OPEN', 'DONE')),
  handled_by      uuid references public.profiles (user_id) on delete set null,
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint reports_target_shape check (
    (target_type = 'USER'  and target_user_id  is not null and target_group_id is null) or
    (target_type = 'GROUP' and target_group_id is not null and target_user_id  is null))
);

create index idx_reports_open on public.reports (status, created_at desc);
-- 같은 대상 하루 1번 확인용
create index idx_reports_dedupe on public.reports (reporter_id, target_user_id, target_group_id, created_at desc);

comment on table public.reports is '신고 — 사람(닉네임 · 사진 · 괴롭힘) 또는 그룹 이름. 넣기는 submit_report, 처리는 운영 화면 (친구 4장, X-10)';

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, insert, update, delete on public.reports to service_role;

-- 신고 넣기 — 사람 줄 · 닉네임 · 사진 · 그룹 이름 (4-마 · 99-03). 신고한 사람에게 알림 없음
--   p_target_type: USER · GROUP / p_reason: USER는 HARASSMENT · NICKNAME · PHOTO · OTHER, GROUP은 GROUP_NAME · HARASSMENT · OTHER
--   p_note: 한 줄 메모(앞뒤 공백 떼고 200자까지, 없어도 됨)
--   상태: REPORTED · ALREADY_REPORTED(같은 대상 하루 1번 — 하루는 신고하는 사람 시간대, X-1) · INVALID · SELF · NOT_FOUND(없는 · 탈퇴 · 내가 못 보는 그룹)
--   검사 순서: 모양(INVALID) → 대상(SELF · NOT_FOUND) → 하루 1번
create function public.submit_report(p_target_type text, p_target_id uuid, p_reason text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_note text;
  v_tz   text;
  v_day0 timestamptz;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  if p_target_type is null or p_reason is null
     or p_target_type not in ('USER', 'GROUP')
     or (p_target_type = 'USER'  and p_reason not in ('HARASSMENT', 'NICKNAME', 'PHOTO', 'OTHER'))
     or (p_target_type = 'GROUP' and p_reason not in ('GROUP_NAME', 'HARASSMENT', 'OTHER'))
     or (p_note is not null and length(p_note) > 1000) then
    return jsonb_build_object('status', 'INVALID');
  end if;
  v_note := nullif(private.trim_spaces(p_note), '');
  if v_note is not null and char_length(v_note) > 200 then
    return jsonb_build_object('status', 'INVALID');
  end if;

  if p_target_id is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_target_type = 'USER' then
    if p_target_id = v_uid then
      return jsonb_build_object('status', 'SELF');
    end if;
    if not exists (select 1 from public.profiles p where p.user_id = p_target_id) then
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;
  elsif not private.is_group_invited_or_member(p_target_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  -- 같은 사람이 같은 대상을 동시에 두 번 눌러도 한 번만
  perform pg_advisory_xact_lock(hashtextextended('report:' || v_uid::text || ':' || p_target_id::text, 0));

  select coalesce(p.timezone, 'Asia/Seoul') into v_tz from public.profiles p where p.user_id = v_uid;
  v_tz := coalesce(v_tz, 'Asia/Seoul');
  v_day0 := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;

  if exists (
    select 1 from public.reports r
    where r.reporter_id = v_uid
      and r.target_type = p_target_type
      and coalesce(r.target_user_id, r.target_group_id) = p_target_id
      and r.created_at >= v_day0
  ) then
    return jsonb_build_object('status', 'ALREADY_REPORTED');
  end if;

  insert into public.reports (reporter_id, target_type, target_user_id, target_group_id, reason, note)
  values (v_uid, p_target_type,
          case when p_target_type = 'USER' then p_target_id end,
          case when p_target_type = 'GROUP' then p_target_id end,
          p_reason, v_note);
  return jsonb_build_object('status', 'REPORTED');
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function private.guard_friend_insert() from public, anon, authenticated;

revoke execute on function
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.my_blocks(),
  public.submit_report(text, uuid, text, text)
from public, anon;

grant execute on function
  public.block_user(uuid),
  public.unblock_user(uuid),
  public.my_blocks(),
  public.submit_report(text, uuid, text, text)
to authenticated;
