-- =====================================================================
-- 친구 15장 — 남용 · 보안 (친구 논리설계 15장, 11/8 확정). 이슈 #431
--   ① 직접 insert 정책 닫기 — 친구 요청 · 그룹 초대는 이미 DB 함수(send_friend_request · invite_to_group)로만 보냄. 같은 일을 하는
--      직접 insert 정책(friends_insert_request · group_members_insert_invite)이 열려 있으면 함수 밖 insert로 횟수 제한(15-02) · 차단 검사를 우회함 (15-라)
--   ② 시험 계정 초기화(dev_reset_my_data)에 친구 · 그룹 참여 · 공유 권한 · 내가 건 차단 · 숨김 삭제 추가 (15-타)
--   안 닫는 것: groups_insert_owner(그룹 만들기 직접 insert) — 앱이 아직 그 길로 만듦(이름 길이 · 10개 상한 · 코드 서버 발급은 트리거가 이미 막음).
--              profiles.wake_ping_enabled 직접 update 거절(15-08) — 앱 PR(#417)이 그 길로 스위치를 바꿈. 둘 다 앱이 함수로 옮긴 뒤 따로
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 직접 insert 정책 닫기
-- ---------------------------------------------------------------------

-- 정책이 없으면 RLS가 앱 역할의 insert를 모두 거절함. 요청은 send_friend_request, 초대는 invite_to_group(둘 다 security definer)이 대신 넣음
drop policy friends_insert_request on public.friends;
drop policy group_members_insert_invite on public.group_members;

-- 직접 insert 가드(4-04)는 이 정책이 열려 있는 동안만 필요했음 — 정책이 닫히면 앱의 직접 insert는 어떤 경우에도 같은 행 권한 거절(42501)이라
--   남겨 두면 오히려 '차단당한 쪽의 insert만 다른 모양(23503)으로 거절'돼 차단당했음이 드러남(4-가). 요청 함수(send_friend_request)가 같은 사람 잠금과 차단 확인을 이미 함
drop trigger guard_friend_insert on public.friends;
drop function private.guard_friend_insert();


-- ---------------------------------------------------------------------
-- 2. 시험 계정 초기화: 친구 · 그룹 · 권한 · 차단도
-- ---------------------------------------------------------------------

-- 부른 사람의 관계 데이터를 지움 (개발 빌드에서만 부르는 dev_reset_my_data가 부름):
--   · 그룹: 멤버 행 삭제 = 나가기와 같은 정리(앞으로 약속의 참여 · 알람, 만든 사람 칸 비움, 마지막 참여 멤버였으면 그룹 삭제) — 초대받은 것 포함
--   · 친구 관계(받은 · 보낸 요청 포함) · 그 관계의 공유 권한(내가 준 것 · 받은 것) — 한 사람을 지우면 상대 화면에서도 사라지는 관계라 양쪽을 같이
--   · 내가 건 차단 · 내가 숨긴 기상 — 남이 나를 차단한 것은 남의 선택이라 그대로
-- 푸시 토큰 · 제한 기록은 그대로 둠 (기기 등록은 다시 안 해도 되고, 제한 기록을 지우면 상한을 되돌리는 우회가 됨)
create function private.dev_reset_friend_data(p_uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_groups  integer;
  v_perms   integer;
  v_friends integer;
  v_blocks  integer;
  v_hides   integer;
begin
  if p_uid is null then
    return jsonb_build_object('groups_left', 0, 'sharing_permissions', 0, 'friends', 0, 'blocks', 0, 'wake_hides', 0);
  end if;

  delete from public.group_members gm where gm.user_id = p_uid;
  get diagnostics v_groups = row_count;

  delete from public.sharing_permissions sp where sp.owner_id = p_uid or sp.grantee_id = p_uid;
  get diagnostics v_perms = row_count;

  delete from public.friends f where f.requester_id = p_uid or f.addressee_id = p_uid;
  get diagnostics v_friends = row_count;

  delete from public.user_blocks b where b.blocker_id = p_uid;
  get diagnostics v_blocks = row_count;

  delete from public.wake_hides h where h.owner_id = p_uid;
  get diagnostics v_hides = row_count;

  return jsonb_build_object('groups_left', v_groups, 'sharing_permissions', v_perms, 'friends', v_friends, 'blocks', v_blocks, 'wake_hides', v_hides);
end;
$$;

revoke execute on function private.dev_reset_friend_data(uuid) from public, anon, authenticated, service_role;

-- 옛 dev_reset_my_data는 그대로 두고(일정 · 알람 · 기록 · 대화 · 프로필) 이름만 비공개 쪽으로 옮겨, 새 dev_reset_my_data가 친구 정리 → 옛 정리 순서로 부름
alter function public.dev_reset_my_data() set schema private;
alter function private.dev_reset_my_data() rename to dev_reset_my_data_core;
revoke execute on function private.dev_reset_my_data_core() from public, anon, authenticated, service_role;

create function public.dev_reset_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_friend jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;
  v_friend := private.dev_reset_friend_data(v_uid);
  return private.dev_reset_my_data_core() || jsonb_build_object('friend_data', v_friend);
end;
$$;

comment on function public.dev_reset_my_data() is
  '개발용 — 부른 사람 본인의 시험 데이터(일정 · 알람 · 기록 · 일기 · AI 대화 · 고친 값 기록 · 제안 · 친구 · 그룹 참여 · 공유 권한 · 내가 건 차단)를 지우고 프로필을 온보딩 전으로 되돌림. 그룹 일정 · 남이 만든 일정은 내 몫만 정리. 개발 빌드에서만 부름';

revoke all on function public.dev_reset_my_data() from public, anon;
grant execute on function public.dev_reset_my_data() to authenticated;
