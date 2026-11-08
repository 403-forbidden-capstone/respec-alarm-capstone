-- =====================================================================
-- 친구 3장 — 친구 관계 (친구 논리설계 3장, 11/8 확정)
--   ① 상태 전이 제한    friends 행은 대기 → 친구로만 바뀜, 수락 시각은 서버가 그 순간 넣음 (3-가 · 3-자 · D64 #8)
--   ② 요청 · 수락 · 거절 · 취소 · 끊기 DB 함수 — 상태 값(jsonb status)으로 돌려줌 (X-7)
--      요청: 반대쪽이 대기면 자동 수락(요청자 = 먼저 보낸 쪽, 3-차), 친구 100명 상한(3-다), 1분 10회 + 하루 50회(3-사)
--      거절 · 취소 · 끊기 = 행 삭제, 기록 없음. 끊기는 친구 출처 권한 행도 지움(지금 트리거 revoke_permissions_on_delete)
--   ③ 30일 지난 받은 요청 정리 — 5분 예약 friend-requests-expire (3-라)
-- 직접 insert 정책(friends_insert_request)은 15장에서 닫음 — 그때까지 앱의 옛 요청 길이 돌게 둠
-- 푸시(FRIEND_REQUEST · FRIEND_ACCEPTED)는 11장 notify 종류 표에서. 여기선 앱이 보낼 자리를 상태 값으로 알려 줌
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 제한 기록에 친구 요청 더함
-- ---------------------------------------------------------------------

alter table public.rate_limit_events
  drop constraint rate_limit_events_action_check,
  add constraint rate_limit_events_action_check check (action in ('HANDLE_SEARCH', 'FRIEND_REQUEST'));


-- ---------------------------------------------------------------------
-- 1. 상태 전이 제한 — 대기 → 친구만, 수락 시각은 서버
-- ---------------------------------------------------------------------

-- 모든 역할에 걸림 (DB 함수 · service_role도). 수락 되돌리기 · PENDING ↔ BLOCKED 같은 다른 전이는 없음 (3-아 · 3-24 · 3-25)
--   수락 시각은 폰 시계가 아니라 수락한 순간의 서버 시각 (3-자 · 3-26)
create function private.guard_friend_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (old.status = 'PENDING' and new.status = 'ACCEPTED') then
      raise exception '친구 상태는 대기 → 친구로만 바뀜 (% → %)', old.status, new.status using errcode = '42501';
    end if;
    new.accepted_at := now();
  elsif new.accepted_at is distinct from old.accepted_at then
    raise exception '수락 시각은 서버가 정함' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_friend_status
  before update on public.friends
  for each row execute function private.guard_friend_status();


-- ---------------------------------------------------------------------
-- 2. 공용 — 두 사람 잠금 · 친구 수
-- ---------------------------------------------------------------------

-- 두 사람 각자에게 잠금을 걸어 이 두 사람이 끼는 요청 · 수락 · 취소 · 차단이 동시에 와도 한 줄씩 (3-05 · 3-28 · 3-29)
--   쌍 하나에만 걸면 (U,B)와 (U,C)가 서로 안 막아, 둘 다 99명을 보고 수락해 101명이 되는 길이 열림(100명 상한 3-다) →
--   사람마다 잠금을 걸고, 교착을 막으려고 uuid 순서대로 건다. 요청 제한 잠금(take_rate_slot)은 항상 이 뒤에 걸려 순환이 없음
create function private.lock_friend_pair(p_a uuid, p_b uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('friend_user:' || least(p_a, p_b)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('friend_user:' || greatest(p_a, p_b)::text, 0));
end;
$$;

-- 수락된 친구 수 (3-다 상한 100명)
create function private.friend_count(p_uid uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.friends f
  where f.status = 'ACCEPTED' and p_uid in (f.requester_id, f.addressee_id);
$$;


-- ---------------------------------------------------------------------
-- 3. 요청 · 수락 · 거절 · 취소 · 끊기
-- ---------------------------------------------------------------------

-- 친구 요청 — 상태: REQUESTED · ACCEPTED(자동 수락) · ALREADY_REQUESTED · ALREADY_FRIEND · SELF · NOT_FOUND · LIMIT · FRIEND_LIMIT
--   NOT_FOUND = 없는 사람 · 탈퇴 · 온보딩 전 · 차단 쌍 (같은 응답, 2-너 · 2-라)
--   제한은 행을 만드는(REQUESTED · ACCEPTED) 요청만 셈, 1분 10회 · 하루 50회(보내는 사람 시간대 0시). 취소해도 안 줄어듦 (3-사 · 3-35)
create function public.send_friend_request(p_target_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  record;
  v_has  boolean;
  v_wait integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_target_id is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_target_id = v_uid then
    return jsonb_build_object('status', 'SELF');
  end if;

  perform private.lock_friend_pair(v_uid, p_target_id);

  if not exists (select 1 from public.profiles p where p.user_id = p_target_id and p.onboarded_at is not null)
     or private.is_blocked_pair(v_uid, p_target_id) then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select f.friend_id, f.requester_id, f.status into v_row
  from public.friends f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_target_id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_target_id);
  v_has := found;

  if v_has and v_row.status = 'ACCEPTED' then
    return jsonb_build_object('status', 'ALREADY_FRIEND');
  end if;
  if v_has and v_row.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_FOUND');   -- 대기 · 친구 말고 다른 상태 행은 없는 사람과 같게
  end if;
  if v_has and v_row.requester_id = v_uid then
    return jsonb_build_object('status', 'ALREADY_REQUESTED');
  end if;

  -- 상한: 내가 100명이면 거절. 자동 수락이면 상대도 봄 (3-다)
  if private.friend_count(v_uid) >= 100 or (v_has and private.friend_count(p_target_id) >= 100) then
    return jsonb_build_object('status', 'FRIEND_LIMIT');
  end if;

  v_wait := private.take_rate_slot(v_uid, 'FRIEND_REQUEST', 10, 50);
  if v_wait > 0 then
    return jsonb_build_object('status', 'LIMIT', 'retry_after_seconds', v_wait);
  end if;

  if v_has then
    -- 상대가 먼저 보낸 대기 → 자동 수락. 요청자는 먼저 보낸 상대 그대로 (3-차 · 3-05)
    update public.friends set status = 'ACCEPTED' where friend_id = v_row.friend_id;
    if found then
      return jsonb_build_object('status', 'ACCEPTED');
    end if;
    -- 그 사이 상대 요청이 지워졌으면(직접 delete · 30일 정리) 내 요청을 새로 보냄
  end if;

  insert into public.friends (requester_id, addressee_id, status) values (v_uid, p_target_id, 'PENDING');
  return jsonb_build_object('status', 'REQUESTED');
end;
$$;

-- 받은 요청 수락 — 상태: ACCEPTED · ALREADY_FRIEND(두 번 누름) · GONE(상대가 취소 · 없음) · FRIEND_LIMIT
create function public.accept_friend_request(p_requester_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  if p_requester_id is null or p_requester_id = v_uid then
    return jsonb_build_object('status', 'GONE');
  end if;

  perform private.lock_friend_pair(v_uid, p_requester_id);

  select f.friend_id, f.requester_id, f.status into v_row
  from public.friends f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_requester_id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_requester_id);

  if found and v_row.status = 'ACCEPTED' then
    return jsonb_build_object('status', 'ALREADY_FRIEND');
  end if;
  if not found or v_row.status <> 'PENDING' or v_row.requester_id <> p_requester_id or private.is_blocked_pair(v_uid, p_requester_id) then
    return jsonb_build_object('status', 'GONE');   -- '이미 처리됐을 수 있어요' (3-카 · 3-28). 차단 쌍의 남은 대기 행도 같은 응답 (4장)
  end if;
  if private.friend_count(v_uid) >= 100 or private.friend_count(p_requester_id) >= 100 then
    return jsonb_build_object('status', 'FRIEND_LIMIT');
  end if;

  update public.friends set status = 'ACCEPTED' where friend_id = v_row.friend_id;
  if not found then
    return jsonb_build_object('status', 'GONE');   -- 고치는 사이 행이 지워졌으면 친구가 됐다고 하지 않음 (3-카)
  end if;
  return jsonb_build_object('status', 'ACCEPTED');
end;
$$;

-- 받은 요청 거절 = 행 삭제, 알림 · 기록 없음 (3-마) — 상태: DECLINED · GONE
create function public.decline_friend_request(p_requester_id uuid)
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
  perform private.lock_friend_pair(v_uid, p_requester_id);
  delete from public.friends f
  where f.requester_id = p_requester_id and f.addressee_id = v_uid and f.status = 'PENDING';
  return jsonb_build_object('status', case when found then 'DECLINED' else 'GONE' end);
end;
$$;

-- 보낸 요청 취소 = 행 삭제 (취소해도 요청 횟수는 그대로) — 상태: CANCELED · GONE
create function public.cancel_friend_request(p_addressee_id uuid)
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
  perform private.lock_friend_pair(v_uid, p_addressee_id);
  delete from public.friends f
  where f.requester_id = v_uid and f.addressee_id = p_addressee_id and f.status = 'PENDING';
  return jsonb_build_object('status', case when found then 'CANCELED' else 'GONE' end);
end;
$$;

-- 친구 끊기 = 행 삭제, 알림 없음 (D64 #9). 친구 출처 권한(양쪽)은 지금 트리거가 지우고, 그룹 출처 · 그룹 기상은 그대로 (3-바)
--   상태: REMOVED · GONE
create function public.remove_friend(p_user_id uuid)
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
  perform private.lock_friend_pair(v_uid, p_user_id);
  delete from public.friends f
  where f.status = 'ACCEPTED'
    and least(f.requester_id, f.addressee_id) = least(v_uid, p_user_id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user_id);
  return jsonb_build_object('status', case when found then 'REMOVED' else 'GONE' end);
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 30일 지난 받은 요청 정리 — 5분 예약 (3-라)
-- ---------------------------------------------------------------------

-- 지운 줄 수를 돌려줌. 받은 사람 화면에서 사라지고 보낸 사람 화면은 [친구 요청]으로 돌아감
create function private.expire_friend_requests()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.friends f where f.status = 'PENDING' and f.requested_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- pg_cron이 있는 곳(실제 Supabase)에서만 예약 — 서버 함수 없이 SQL 한 줄
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('friend-requests-expire', '*/5 * * * *', $cmd$select private.expire_friend_requests()$cmd$);
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. 실행 권한
-- ---------------------------------------------------------------------

revoke execute on function
  private.guard_friend_status(),
  private.lock_friend_pair(uuid, uuid),
  private.friend_count(uuid),
  private.expire_friend_requests()
from public, anon, authenticated;

revoke execute on function
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid),
  public.decline_friend_request(uuid),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid)
from public, anon;

grant execute on function
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid),
  public.decline_friend_request(uuid),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid)
to authenticated;
