// 대본이 부르는 DB 함수 이름 스위치판.
//   값이 있고 DB에 실제로 있으면 → 그 함수를 부름 (없으면 표를 직접 만지는 main 방식, 또는 SKIP)
//   값이 null → 아직 이름이 정해지지 않음 (친구_세션약속.md 1절에 S1이 적으면 여기에 넣고 그 단계 본문을 채움)
// 함수가 DB에 생기면 그 단계는 SKIP에서 PASS / FAIL로 바뀜 — 그래서 이름을 채우는 것이 "장 PR 머지 뒤 재실행"의 첫 일
export const RPC = {
  // 지금 main에 있음
  find_profile: 'find_profile_by_handle', // 옛 모양(15장에서 지워짐) — search_by_handle이 없을 때만 씀
  join_group: 'join_group_by_invite_code',
  regen_code: 'regenerate_invite_code',
  group_wake: 'get_group_wake', // 15장(#434)부터 대본은 줄인 응답(get_group_wake)만 씀. 11칸짜리 get_group_wake_status는 내 줄 상세용으로 남아 있음
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

  // 6 · 7 · 8 · 10 · 12장 (main) — 서버 전용(service_role)은 admin으로 부름
  save_group_permissions: 'save_group_permissions',
  wake_hide: 'set_wake_hidden', // 7장: 사람별 기상 숨기기
  wake_ping: 'plan_wake_ping', // 8장 깨우기 판정 · 횟수 세기 (서버 전용)
  unconfirmed_batch: 'claim_wake_nudges', // 8장 미확인 친구 알림 받는 사람 정하기 (서버 전용)
  my_wake_pings: 'my_wake_pings',
  alarm_suggest: 'propose_alarm_time', // 10장
  alarm_suggest_apply: 'respond_alarm_proposal',
  my_proposals: 'my_alarm_proposals',
  sent_proposals: 'sent_alarm_proposals',
  prepare_account_delete: 'prepare_account_delete', // 12장 (서버 전용)
  account_summary: 'my_account_delete_summary',

  // 4장 (PR #380) — 입력 모양은 S1이 만든 뒤 맞춤
  block_user: 'block_user',
  unblock_user: 'unblock_user',
  my_blocks: 'my_blocks',
  submit_report: 'submit_report',

  // 아직 이름 없음 ( 5 · 6 · 7 · 8 · 9 · 10 · 12장)
};

// 이름이 있고 DB에도 있을 때만 이름을 돌려줌
export function rpcOf(caps, key) {
  const name = RPC[key];
  return name && caps.hasRpc(name) ? name : null;
}
