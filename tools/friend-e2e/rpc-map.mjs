// 대본이 부르는 DB 함수 이름 스위치판.
//   값이 있고 DB에 실제로 있으면 → 그 함수를 부름 (없으면 표를 직접 만지는 main 방식, 또는 SKIP)
//   값이 null → 아직 이름이 정해지지 않음 (친구_세션약속.md 1절에 S1이 적으면 여기에 넣고 그 단계 본문을 채움)
// 함수가 DB에 생기면 그 단계는 SKIP에서 PASS / FAIL로 바뀜 — 그래서 이름을 채우는 것이 "장 PR 머지 뒤 재실행"의 첫 일
export const RPC = {
  // 지금 main에 있음
  find_profile: 'find_profile_by_handle', // 옛 모양(15장에서 지워짐) — search_by_handle이 없을 때만 씀
  join_group: 'join_group_by_invite_code',
  regen_code: 'regenerate_invite_code',
  group_wake: 'get_group_wake_status',
  shared_alarms: 'get_shared_alarm_appointments',
  register_push_token: 'register_push_token',

  // 2장 (PR #368) — 친구_세션약속.md 1절
  change_handle: 'change_my_handle',
  search_handle: 'search_by_handle',
  search_name: 'search_related_by_name',
  friend_link: 'my_friend_link',
  open_link: 'open_friend_link',

  // 3장 (PR #374) — 친구_세션약속.md 1절
  friend_request: 'send_friend_request',
  friend_accept: 'accept_friend_request',
  friend_decline: 'decline_friend_request',
  friend_cancel: 'cancel_friend_request',
  friend_remove: 'remove_friend',

  // 5장 (PR #387) — 옛 join_group(join_group_by_invite_code)은 그대로 남아 있고, 새 함수는 group_ 이름으로
  group_preview: 'preview_group_by_code',
  group_join: 'join_group',
  group_invite: 'invite_to_group',
  group_accept: 'accept_group_invite',
  group_invites: 'my_group_invites',
  group_code: 'my_group_code',

  // 4장 (PR #380) — 입력 모양은 S1이 만든 뒤 맞춤
  block_user: 'block_user',
  unblock_user: 'unblock_user',
  my_blocks: 'my_blocks',
  submit_report: 'submit_report',

  // 아직 이름 없음 ( 5 · 6 · 7 · 8 · 9 · 10 · 12장)
  save_permissions: null, // 6장 저장 (설정⊂조회)
  wake_confirm: null, // 7장 기상 확인
  wake_hide: null, // 7장 특정 멤버에게 기상 숨기기
  wake_ping: null, // 8장 깨우기
  unconfirmed_batch: null, // 8장 미확인 알림 (배치)
  join_appointment: null, // 9장 [내 알람 만들기]
  alarm_suggest: null, // 10장 알람 바꾸기 제안 보내기
  alarm_suggest_apply: null, // 10장 제안 [적용]
  prepare_account_delete: null, // 12장 탈퇴 준비
};

// 이름이 있고 DB에도 있을 때만 이름을 돌려줌
export function rpcOf(caps, key) {
  const name = RPC[key];
  return name && caps.hasRpc(name) ? name : null;
}
