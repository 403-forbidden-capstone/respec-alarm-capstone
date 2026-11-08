-- =====================================================================
-- 친구 5장 — 그룹 · 초대, 그룹장 없음 (친구 논리설계 5장, 11/8 확정)
--   ① 그룹장 없음: 이름 바꾸기 · 새 코드 · 초대 · 내보내기는 참여 중 멤버 누구나, 삭제 길 없음, '만든 사람'은 기록 칸 (5-라 · D64 #11)
--   ② 마지막 참여 멤버가 나가면(탈퇴 포함) 그룹 · 공동 약속 · 초대 · 코드 자동 삭제, 나가는 사람의 공동 약속 참여 · 알람 삭제 (5-사 · 9-파)
--   ③ 초대 코드: 헷갈리는 글자(0 O 1 I) 뺀 8자, 만료 7일(마지막 발급 기준), 시트를 열 때 만료면 자동 재발급, 기존 그룹은 이 마이그레이션 시각 + 7일 (5-머 · 5-러)
--   ④ 미리보기 · 코드 참여 · 초대 수락 함수: 틀린 코드 계정별 1시간 10번(막힌 동안은 맞는 코드도 거절), 반환값 방식, 20명 · 10개 상한 + 잠금 (5-다 · 5-더)
--   ⑤ 직접 초대: 친구 사이 · 차단 아님만, 초대만 받은 사람은 카드 범위만(그룹 표 · 멤버 목록 · 공개 프로필을 참여 중으로 좁힘) (5-파 · 5-하)
--   ⑥ 이름 검사(앞뒤 공백 · 1~50자), 다시 참여는 함수로만(직접 상태 바꾸기 막음, 동의 · 알림 끄기 처음 값) (5-카 · 5-마)
-- 푸시(GROUP_MEMBER_JOINED · 그룹 알림 끄기 반영)는 11장, 지금 앱이 쓰는 join_group_by_invite_code · regenerate_invite_code는 옛 모양으로 남김
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 제한 기록에 틀린 코드 더함
-- ---------------------------------------------------------------------

alter table public.rate_limit_events
  drop constraint rate_limit_events_action_check,
  add constraint rate_limit_events_action_check check (action in ('HANDLE_SEARCH', 'FRIEND_REQUEST', 'GROUP_CODE_FAIL'));


-- ---------------------------------------------------------------------
-- 1. 칸 바꾸기
-- ---------------------------------------------------------------------

-- 그룹: 만든 사람은 기록일 뿐 — 탈퇴해도 그룹은 남으니 비울 수 있게 (5-24)
alter table public.groups drop constraint groups_owner_id_fkey;
alter table public.groups alter column owner_id drop not null;
alter table public.groups add constraint groups_owner_id_fkey foreign key (owner_id) references public.profiles (user_id) on delete set null;
comment on column public.groups.owner_id is '만든 사람 — 기록일 뿐 권한 없음(그룹장 없음, D64 #11). 만든 사람이 탈퇴하면 비어 있음';

-- 코드 발급 · 만료 칸. 기존 그룹은 이 시각 + 7일 (add column의 기본값이 한 번만 계산돼 모두 같은 시각)
alter table public.groups
  add column invite_code_issued_at  timestamptz not null default now(),
  add column invite_code_expires_at timestamptz not null default now() + interval '7 days';
comment on column public.groups.invite_code_expires_at is '코드 만료 — 마지막 발급 + 7일. 시트를 열 때 만료면 서버가 새 코드로 바꿈';

-- 이름: 앞뒤 공백을 떼고 1~50자 (varchar(50)이면 공백 붙은 50자가 트리거 전에 걸려서 text로)
update public.groups
set group_name = coalesce(nullif(regexp_replace(group_name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''), '이름 없는 그룹');
alter table public.groups alter column group_name type text;
alter table public.groups add constraint groups_name_ok
  check (char_length(group_name) between 1 and 50 and group_name !~ '^[[:space:]]|[[:space:]]$');

-- 그룹 구성원: 초대한 사람 · 초대 시각(초대 카드) · 이 그룹 알림 끄기 (5-하 · 5-커)
alter table public.group_members
  add column invited_by        uuid references public.profiles (user_id) on delete set null,
  add column invited_at        timestamptz,
  add column notifications_off boolean not null default false;
comment on column public.group_members.invited_by is '직접 초대한 사람(초대 대기일 때만 의미)';
comment on column public.group_members.notifications_off is '이 그룹에서 오는 알림 전부 끄기 (깨우기는 사람 단위라 따로, 5-커)';


-- ---------------------------------------------------------------------
-- 2. 공용 — 코드 만들기 · 잠금 · 개수
-- ---------------------------------------------------------------------

-- 새 초대 코드: 5장 글자표(0 O 1 I 뺀 32자) 8자. 열 기본값이라 앱 역할이 실행할 수 있어야 하고, 안에서 쓰는 생성 함수는 소유자 권한으로 부름
create function private.new_group_code()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select private.random_code(8, private.code_alphabet());
$$;

alter table public.groups alter column invite_code set default private.new_group_code();

-- 참여 중(JOINED) 인원 · 한 사람이 참여 중인 그룹 수 (20명 · 10개 상한)
create function private.group_member_count(p_group_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.group_members gm where gm.group_id = p_group_id and gm.invite_status = 'JOINED';
$$;

create function private.joined_group_count(p_uid uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.group_members gm where gm.user_id = p_uid and gm.invite_status = 'JOINED';
$$;

-- 같은 그룹 · 같은 사람의 참여 · 수락이 한 줄씩 (그룹 잠금 → 사람 잠금 순서로만 걸어 교착 없음)
create function private.lock_group(p_group_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text, 0));
$$;

create function private.lock_group_user(p_uid uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('group_user:' || p_uid::text, 0));
$$;

-- 앱 역할이 직접 그룹을 만들 때(10개 상한을 세기 전에) 자기 사람 잠금만 거는 얇은 함수 — 참여 · 수락과 같은 열쇠라 겹쳐도 11개가 안 됨.
-- 남의 열쇠를 못 걸게 인자가 없고 로그인한 본인 것만 잡음
create function private.lock_my_group_user()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.lock_group_user((select auth.uid()))
  where (select auth.uid()) is not null;
$$;

-- 코드 다시 발급: 이미 쓰는 코드와 겹치면 다시 (유일 색인이 막음)
create function private.reissue_group_code(p_group_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_code text;
begin
  for i in 1..20 loop
    begin
      update public.groups g
      set invite_code = private.new_group_code(), invite_code_issued_at = now(), invite_code_expires_at = now() + interval '7 days'
      where g.group_id = p_group_id
      returning g.invite_code into v_code;
      return v_code;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception '초대 코드를 만들지 못함';
end;
$$;

-- 입력한 코드를 맞춤: 공백 모두 빼고 대문자로. 길이 · 글자가 틀리면 null(없는 코드로 셈, 15-마). O/0 같은 보정은 안 함 (5-13)
create function private.normalize_group_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code is null or length(p_code) > 64 then null
    else (select case when c ~ '^[A-Z0-9]{6,12}$' then c end from (select upper(regexp_replace(p_code, '[[:space:]]', '', 'g')) as c) t)
  end;
$$;

-- 틀린 코드 계정별 1시간 10번: 지난 1시간 안의 실패가 10개면 막힘, 남은 초 = 그중 가장 오래된 것이 1시간을 벗어날 때까지. 막히지 않았으면 0
create function private.group_code_wait(p_uid uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when count(*) >= 10
              then greatest(1, ceil(extract(epoch from (min(t.created_at) + interval '1 hour' - now())))::integer)
              else 0 end
  from (
    select e.created_at from public.rate_limit_events e
    where e.user_id = p_uid and e.action = 'GROUP_CODE_FAIL' and e.created_at > now() - interval '1 hour'
    order by e.created_at desc
    limit 10
  ) t;
$$;

create function private.group_code_fail(p_uid uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into public.rate_limit_events (user_id, action) values (p_uid, 'GROUP_CODE_FAIL');
$$;

-- 이 사람이 그룹에 직접 초대할 수 있는 상대인가: 내가 참여 중 멤버 + 상대는 내 친구 + 차단 아님. 직접 초대 insert 정책이 씀
create function private.can_invite_to_group(p_group_id uuid, p_target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and p_target_id is distinct from (select auth.uid())
    and exists (
      select 1 from public.group_members gm
      where gm.group_id = p_group_id and gm.user_id = (select auth.uid()) and gm.invite_status = 'JOINED')
    and exists (
      select 1 from public.friends f
      where f.status = 'ACCEPTED'
        and least(f.requester_id, f.addressee_id) = least((select auth.uid()), p_target_id)
        and greatest(f.requester_id, f.addressee_id) = greatest((select auth.uid()), p_target_id))
    and not private.is_blocked_pair((select auth.uid()), p_target_id);
$$;


-- ---------------------------------------------------------------------
-- 3. 이름 검사 · 앱이 못 바꾸는 칸 · 인원 상한 (트리거)
-- ---------------------------------------------------------------------

-- 이름 앞뒤 공백(탭 · 줄바꿈 포함)을 떼고 저장. 비었거나 50자가 넘으면 위 check가 거절 (5-카)
create function private.normalize_group_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.group_name := regexp_replace(new.group_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  return new;
end;
$$;

create trigger normalize_group_name
  before insert or update of group_name on public.groups
  for each row execute function private.normalize_group_name();

-- 앱 역할(authenticated · anon)이 그룹 행에서: 만들 때 코드 · 만료는 서버가 정하고 한 사람 10개 상한, 고칠 때 이름 · 설명 말고는 못 바꿈
--   소유자 권한으로 도는 함수 · service_role은 그대로. definer가 아닌 트리거라 current_user가 호출한 역할 (2장 guard_profile_columns와 같은 방식)
create function private.guard_group_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      perform private.lock_my_group_user();
      if (select count(*) from public.group_members gm where gm.user_id = new.owner_id and gm.invite_status = 'JOINED') >= 10 then
        raise exception '그룹은 10개까지 참여할 수 있음' using errcode = '54000';
      end if;
      new.created_at := now();
      new.invite_code := private.new_group_code();
      new.invite_code_issued_at := now();
      new.invite_code_expires_at := now() + interval '7 days';
    else
      if new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at or new.group_id is distinct from old.group_id then
        raise exception '만든 사람 · 만든 시각 · 번호는 바꿀 수 없음' using errcode = '42501';
      end if;
      if new.invite_code is distinct from old.invite_code
         or new.invite_code_issued_at is distinct from old.invite_code_issued_at
         or new.invite_code_expires_at is distinct from old.invite_code_expires_at then
        raise exception '초대 코드는 새 코드 함수로만 바뀜' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_group_row
  before insert or update on public.groups
  for each row execute function private.guard_group_row();

-- 앱 역할이 그룹 구성원 행에서: 초대를 넣을 때 초대한 사람 · 시각은 서버가 정하고, 고칠 때는 JOINED → LEFT(나가기) 말고 상태를 못 바꾸며
-- (초대 수락 · 다시 참여는 함수로만, 버그 f), 참여 일시 · 초대 기록은 못 바꾸고, 동의 · 알림 끄기는 참여 중일 때만 바꿈 (5-마 · 5-d6)
create function private.guard_group_member_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.invited_by := (select auth.uid());
      new.invited_at := now();
      new.notifications_off := false;
    else
      if new.invite_status is distinct from old.invite_status and not (old.invite_status = 'JOINED' and new.invite_status = 'LEFT') then
        raise exception '그룹 상태는 나가기 말고 함수로만 바뀜' using errcode = '42501';
      end if;
      if new.joined_at is distinct from old.joined_at or new.invited_by is distinct from old.invited_by or new.invited_at is distinct from old.invited_at then
        raise exception '참여 일시 · 초대 기록은 바꿀 수 없음' using errcode = '42501';
      end if;
      if old.invite_status <> 'JOINED'
         and (new.wake_share_opt_in is distinct from old.wake_share_opt_in or new.notifications_off is distinct from old.notifications_off) then
        raise exception '참여 중일 때만 바꿀 수 있음' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_group_member_row
  before insert or update on public.group_members
  for each row execute function private.guard_group_member_row();

-- 초대한 사람이 탈퇴하면 on delete set null이 이 칸을 찾아야 하므로 (순차 검색 방지)
create index idx_group_members_invited_by on public.group_members (invited_by) where invited_by is not null;


-- ---------------------------------------------------------------------
-- 4. 나갈 때 정리 · 마지막 멤버면 그룹 삭제 · 내보내면 코드 교체
-- ---------------------------------------------------------------------

-- 참여 중이던 사람이 나가거나(JOINED → LEFT) 행이 지워지면(내보내기 · 탈퇴 연쇄):
--   그 그룹 공동 약속의 내 참여 · 알람 삭제 (9-파), 참여 중인 사람이 아무도 안 남으면 그룹 삭제 → 공동 약속 · 초대 · 코드 연쇄 삭제.
--   각자 지난 기상 기록(daily_records)은 그룹과 연결이 없어 남음 (5-사)
--   그룹 행을 먼저 잠가 둘이 동시에 나가도 나중 사람이 앞 사람의 나감을 보고 마지막으로 처리됨 (5-39)
create function private.after_group_member_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.appointment_participants ap
  using public.appointments a
  where ap.appointment_id = a.appointment_id
    and a.group_id = old.group_id
    and ap.user_id = old.user_id;

  perform 1 from public.groups g where g.group_id = old.group_id for update;
  if found and not exists (
    select 1 from public.group_members gm where gm.group_id = old.group_id and gm.invite_status = 'JOINED'
  ) then
    delete from public.groups g where g.group_id = old.group_id;
  end if;
  return null;
end;
$$;

create trigger after_group_member_left
  after update of invite_status on public.group_members
  for each row when (old.invite_status = 'JOINED' and new.invite_status <> 'JOINED')
  execute function private.after_group_member_gone();

create trigger after_group_member_removed
  after delete on public.group_members
  for each row when (old.invite_status = 'JOINED')
  execute function private.after_group_member_gone();

-- 참여 중 멤버가 다른 사람을 내보내면(행 삭제) 초대 코드를 새로 바꿈 — 내보내진 사람이 옛 코드로 바로 다시 들어오지 못하게 (5-버)
--   스스로 나간 경우 · 탈퇴 연쇄 · 서버가 지운 경우(로그인 정보 없음)는 그대로
create or replace function private.rotate_invite_code_on_kick()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.invite_status = 'JOINED'
     and old.user_id is distinct from (select auth.uid())
     and exists (
       select 1 from public.group_members gm
       where gm.group_id = old.group_id and gm.user_id = (select auth.uid()) and gm.invite_status = 'JOINED') then
    perform private.reissue_group_code(old.group_id);
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 읽기 · 쓰기 정책 (그룹장 없음, 초대만 받은 사람은 카드 범위만)
-- ---------------------------------------------------------------------

-- groups: 참여 중인 사람만 읽음. 방금 만든 사람은 만든 직후(같은 트랜잭션)에 돌려받을 수 있게 만든 사람 + 만든 시각 = 이 트랜잭션 시각만 더 허용
--   (만든 사람이 구성원 행에 들어가는 건 insert 뒤 트리거라 returning에서는 아직 참여 중으로 안 보임. 만든 시각은 트리거가 now()로 못 박고 못 바꿈)
drop policy groups_select_member on public.groups;
create policy groups_select_member on public.groups
  for select to authenticated
  using (private.is_group_member(group_id)
         or (owner_id = (select auth.uid()) and created_at = now()));

-- 이름 · 설명은 참여 중 멤버 누구나 고침 (코드 · 만든 사람은 위 트리거가 막음). 삭제 길은 없음
drop policy groups_update_owner on public.groups;
create policy groups_update_member on public.groups
  for update to authenticated
  using (private.is_group_member(group_id))
  with check (private.is_group_member(group_id));

drop policy groups_delete_owner on public.groups;

-- group_members: 내 행과 참여 중인 그룹의 구성원 목록. 직접 초대는 참여 중 멤버가 자기 친구(차단 아님)에게만.
--   내보내기 = 참여 중 멤버 누구나 다른 사람의 행을 지움(초대 취소 포함), 내 행은 내가 지움(초대 거절 · 나감 기록 정리)
drop policy group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_group_member(group_id));

drop policy group_members_insert_invite on public.group_members;
create policy group_members_insert_invite on public.group_members
  for insert to authenticated
  with check (invite_status = 'INVITED'
              and wake_share_opt_in = false
              and joined_at is null
              and private.can_invite_to_group(group_id, user_id));

drop policy group_members_delete on public.group_members;
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_group_member(group_id));

-- 이제 쓰는 곳이 없는 '만든 사람인가' 판정
drop function private.is_group_owner(uuid);


-- ---------------------------------------------------------------------
-- 6. 공개 프로필 — 초대만 받은 사람은 그룹 구성원을 못 봄 (참여 중끼리만)
-- ---------------------------------------------------------------------

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
    where mine.invite_status = 'JOINED'
      and other.invite_status = 'JOINED'
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
-- 7. 코드 미리보기 · 참여 · 초대 수락 · 직접 초대 · 받은 초대 · 코드 시트
-- ---------------------------------------------------------------------

-- 코드 입력 → 미리보기. 참여는 안 시킴. 상태: FOUND · NOT_FOUND(없는 · 형식 밖) · EXPIRED · LIMIT(1시간 안 틀린 코드 10번)
--   틀린 코드(없음 · 만료)는 실패로 기록하고 반환값으로 돌려줘서 예외로 되돌려지지 않음 (5-16). 막힌 동안은 맞는 코드도 LIMIT (5-15)
create function public.preview_group_by_code(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text;
  v_wait  integer;
  v_g     record;
  v_found boolean := false;
  v_n     integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rate:GROUP_CODE_FAIL:' || v_uid::text, 0));
  v_wait := private.group_code_wait(v_uid);
  if v_wait > 0 then
    return jsonb_build_object('status', 'LIMIT', 'retry_after_seconds', v_wait);
  end if;

  v_code := private.normalize_group_code(p_code);
  if v_code is not null then
    select g.group_id, g.group_name, g.invite_code_expires_at into v_g from public.groups g where g.invite_code = v_code;
    v_found := found;
  end if;
  if not v_found then
    perform private.group_code_fail(v_uid);
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_g.invite_code_expires_at <= now() then
    perform private.group_code_fail(v_uid);
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  v_n := private.group_member_count(v_g.group_id);
  return jsonb_build_object(
    'status', 'FOUND',
    'group_name', v_g.group_name,
    'member_count', v_n,
    'full', v_n >= 20,
    'already_joined', exists (select 1 from public.group_members gm where gm.group_id = v_g.group_id and gm.user_id = v_uid and gm.invite_status = 'JOINED'),
    'expires_at', v_g.invite_code_expires_at);
end;
$$;

-- 코드로 참여(= 직접 초대를 받았으면 초대 수락). 상태: JOINED · ALREADY_JOINED · NOT_FOUND · EXPIRED · LIMIT · FULL(20명) · TOO_MANY_GROUPS(10개)
--   차단 쌍이어도 막지 않음(참여는 되고 서로 이름만, 4장). 처음 상태로 시작: 기상 공유 동의는 p_wake_share, 알림 끄기는 꺼짐, 참여 일시는 지금.
--   그룹 잠금 → 사람 잠금 순서로 걸어 같은 그룹의 동시 참여는 한 명씩 인원을 세고, 같은 사람의 두 기기 참여는 한 번만 (5-32 · 5-35)
create function public.join_group(p_code text, p_wake_share boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text;
  v_wait  integer;
  v_g     record;
  v_found boolean := false;
  v_st    public.invite_status;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rate:GROUP_CODE_FAIL:' || v_uid::text, 0));
  v_wait := private.group_code_wait(v_uid);
  if v_wait > 0 then
    return jsonb_build_object('status', 'LIMIT', 'retry_after_seconds', v_wait);
  end if;

  v_code := private.normalize_group_code(p_code);
  if v_code is not null then
    select g.group_id into v_g from public.groups g where g.invite_code = v_code;
    v_found := found;
  end if;
  if not v_found then
    perform private.group_code_fail(v_uid);
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  perform private.lock_group(v_g.group_id);
  perform private.lock_group_user(v_uid);

  -- 잠금을 건 뒤 다시 읽음(그 사이 코드가 바뀌거나 그룹이 지워졌을 수 있음)
  -- 행을 키 공유로 잡아, 마지막 멤버가 나가며 그룹을 지우는 일(트리거의 for update)과 겹쳐도 지워진 그룹에 참여가 성공으로 끝나지 않게 함
  select g.group_id, g.invite_code_expires_at into v_g from public.groups g where g.group_id = v_g.group_id and g.invite_code = v_code for key share;
  if not found then
    perform private.group_code_fail(v_uid);
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_g.invite_code_expires_at <= now() then
    perform private.group_code_fail(v_uid);
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  select gm.invite_status into v_st from public.group_members gm where gm.group_id = v_g.group_id and gm.user_id = v_uid;
  if v_st = 'JOINED' then
    return jsonb_build_object('status', 'ALREADY_JOINED', 'group_id', v_g.group_id);
  end if;
  if private.group_member_count(v_g.group_id) >= 20 then
    return jsonb_build_object('status', 'FULL');
  end if;
  if private.joined_group_count(v_uid) >= 10 then
    return jsonb_build_object('status', 'TOO_MANY_GROUPS');
  end if;

  insert into public.group_members as gm (group_id, user_id, invite_status, joined_at, wake_share_opt_in, notifications_off)
  values (v_g.group_id, v_uid, 'JOINED', now(), coalesce(p_wake_share, false), false)
  on conflict (group_id, user_id) do update
    set invite_status = 'JOINED', joined_at = now(), wake_share_opt_in = coalesce(p_wake_share, false),
        notifications_off = false, invited_by = null, invited_at = null;
  return jsonb_build_object('status', 'JOINED', 'group_id', v_g.group_id);
end;
$$;

-- 받은 직접 초대 수락. 상태: JOINED · ALREADY_JOINED · GONE(초대가 없음 · 취소됨) · FULL · TOO_MANY_GROUPS
create function public.accept_group_invite(p_group_id uuid, p_wake_share boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_st  public.invite_status;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_group_id is null then
    return jsonb_build_object('status', 'GONE');
  end if;

  perform private.lock_group(p_group_id);
  perform private.lock_group_user(v_uid);

  -- 그룹 행을 키 공유로 잡음 — 마지막 멤버가 나가며 그룹을 지우는 일과 겹쳐도 수락이 성공으로 끝나지 않고 GONE (join_group과 같음)
  perform 1 from public.groups g where g.group_id = p_group_id for key share;
  if not found then
    return jsonb_build_object('status', 'GONE');
  end if;
  select gm.invite_status into v_st from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid;
  if v_st = 'JOINED' then
    return jsonb_build_object('status', 'ALREADY_JOINED', 'group_id', p_group_id);
  end if;
  if v_st is distinct from 'INVITED' then
    return jsonb_build_object('status', 'GONE');
  end if;
  if private.group_member_count(p_group_id) >= 20 then
    return jsonb_build_object('status', 'FULL');
  end if;
  if private.joined_group_count(v_uid) >= 10 then
    return jsonb_build_object('status', 'TOO_MANY_GROUPS');
  end if;

  update public.group_members gm
  set invite_status = 'JOINED', joined_at = now(), wake_share_opt_in = coalesce(p_wake_share, false),
      notifications_off = false, invited_by = null, invited_at = null
  where gm.group_id = p_group_id and gm.user_id = v_uid;
  return jsonb_build_object('status', 'JOINED', 'group_id', p_group_id);
end;
$$;

-- 직접 초대: 참여 중 멤버 누구나 자기 친구를 (친구 사이 · 차단 아님만, 남발 제한 없음 — 한 사람에 행 하나). 나간 사람은 다시 초대 대기로
--   상태: INVITED · ALREADY_INVITED · ALREADY_MEMBER · SELF · NOT_FOUND(내가 멤버가 아님 · 친구가 아님 · 차단 · 없는 사람, 같은 응답)
create function public.invite_to_group(p_group_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_st  public.invite_status;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_user_id is not null and p_user_id = v_uid then
    return jsonb_build_object('status', 'SELF');
  end if;
  if p_group_id is null or p_user_id is null or not exists (
    select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invite_status = 'JOINED'
  ) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  perform private.lock_group(p_group_id);
  -- 이미 멤버 · 초대 중인지는 참여 중 멤버가 원래 볼 수 있는 정보라 먼저 알려 줌
  select gm.invite_status into v_st from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_user_id;
  if v_st = 'JOINED' then
    return jsonb_build_object('status', 'ALREADY_MEMBER');
  end if;
  if v_st = 'INVITED' then
    return jsonb_build_object('status', 'ALREADY_INVITED');
  end if;
  if not private.can_invite_to_group(p_group_id, p_user_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  insert into public.group_members as gm (group_id, user_id, invite_status, invited_by, invited_at)
  values (p_group_id, p_user_id, 'INVITED', v_uid, now())
  on conflict (group_id, user_id) do update
    set invite_status = 'INVITED', invited_by = v_uid, invited_at = now(), joined_at = null,
        wake_share_opt_in = false, notifications_off = false;
  return jsonb_build_object('status', 'INVITED');
end;
$$;

-- G01 위 받은 초대 카드 — 그룹 이름 · 인원(참여 중만) · 초대한 사람까지만. 코드 · 멤버 목록은 수락 뒤 (5-하). 안 누른 초대는 만료 없이 계속 (5-거)
--   로그인 정보가 없으면 빈 결과
create function public.my_group_invites()
returns table (group_id uuid, group_name text, member_count integer, invited_by uuid, invited_by_nickname varchar, invited_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.group_id, g.group_name, private.group_member_count(g.group_id), gm.invited_by, p.nickname, gm.invited_at
  from public.group_members gm
  join public.groups g on g.group_id = gm.group_id
  left join public.profiles p on p.user_id = gm.invited_by
  where gm.user_id = (select auth.uid()) and gm.invite_status = 'INVITED'
  order by gm.invited_at desc nulls last, g.group_name;
$$;

-- 코드 시트를 열 때 — 만료됐으면 누가 열든 서버가 새 코드 + 7일로 바꿔 줌 (5-러). 참여 중 멤버만, 아니면 NOT_FOUND
create function public.my_group_code(p_group_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_g   record;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_group_id is null or not exists (
    select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invite_status = 'JOINED'
  ) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  perform private.lock_group(p_group_id);
  select g.invite_code, g.invite_code_expires_at into v_g from public.groups g where g.group_id = p_group_id;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_g.invite_code_expires_at <= now() then
    perform private.reissue_group_code(p_group_id);
    select g.invite_code, g.invite_code_expires_at into v_g from public.groups g where g.group_id = p_group_id;
  end if;
  return jsonb_build_object('status', 'OK', 'code', v_g.invite_code, 'expires_at', v_g.invite_code_expires_at);
end;
$$;

-- [새 코드] — 참여 중 멤버 누구나(그룹장 없음). 옛 코드는 바로 못 쓰고 새 코드는 7일. 반환은 지금 앱과 같은 글자 하나
create or replace function public.regenerate_invite_code(p_group_id uuid)
returns text
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
  if not exists (
    select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid and gm.invite_status = 'JOINED'
  ) then
    raise exception '참여 중인 멤버만 초대 코드를 바꿀 수 있음' using errcode = '42501';
  end if;
  perform private.lock_group(p_group_id);
  return private.reissue_group_code(p_group_id);
end;
$$;

-- 지금 앱이 쓰는 코드 참여(옛 모양): 새 규칙(만료 · 20명 · 10개)은 걸리지만 실패는 예외라 틀린 코드 횟수는 못 셈 → 앱이 join_group으로 옮기면 15장에서 지움
create or replace function public.join_group_by_invite_code(p_invite_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r jsonb;
begin
  v_r := public.join_group(p_invite_code, false);
  case v_r ->> 'status'
    when 'JOINED' then return (v_r ->> 'group_id')::uuid;
    when 'ALREADY_JOINED' then return (v_r ->> 'group_id')::uuid;
    when 'EXPIRED' then raise exception '만료된 초대 코드';
    when 'LIMIT' then raise exception '잠시 뒤 다시 해 주세요';
    when 'FULL' then raise exception '그룹이 가득 찼음';
    when 'TOO_MANY_GROUPS' then raise exception '그룹은 10개까지 참여할 수 있음';
    else raise exception '초대 코드가 맞지 않음';
  end case;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function
  private.new_group_code(),
  private.group_member_count(uuid),
  private.joined_group_count(uuid),
  private.lock_group(uuid),
  private.lock_group_user(uuid),
  private.lock_my_group_user(),
  private.reissue_group_code(uuid),
  private.normalize_group_code(text),
  private.group_code_wait(uuid),
  private.group_code_fail(uuid),
  private.can_invite_to_group(uuid, uuid),
  private.normalize_group_name(),
  private.guard_group_row(),
  private.guard_group_member_row(),
  private.after_group_member_gone()
from public, anon, authenticated;

-- 앱 역할이 정책 · 기본값 · 트리거 안에서 직접 부르는 것만 다시 엶
grant execute on function private.new_group_code() to authenticated, service_role;   -- 열 기본값이라 그룹을 넣는 시드(service_role)도 실행해야 함
grant execute on function private.can_invite_to_group(uuid, uuid) to authenticated;
grant execute on function private.lock_my_group_user() to authenticated;   -- guard_group_row(앱 역할로 도는 트리거)가 부름

revoke execute on function
  public.preview_group_by_code(text),
  public.join_group(text, boolean),
  public.accept_group_invite(uuid, boolean),
  public.invite_to_group(uuid, uuid),
  public.my_group_invites(),
  public.my_group_code(uuid)
from public, anon;

grant execute on function
  public.preview_group_by_code(text),
  public.join_group(text, boolean),
  public.accept_group_invite(uuid, boolean),
  public.invite_to_group(uuid, uuid),
  public.my_group_invites(),
  public.my_group_code(uuid)
to authenticated;
