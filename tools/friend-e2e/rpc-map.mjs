// 대본이 부르는 DB 함수 이름 스위치판.
//   값이 있고 DB에 실제로 있으면 → 그 함수를 부름 (없으면 표를 직접 만지는 main 방식, 또는 SKIP)
//   값이 null → 아직 이름이 정해지지 않음 (친구_세션약속.md 1절에 S1이 적으면 여기에 넣고 그 단계 본문을 채움)
// 함수가 DB에 생기면 그 단계는 SKIP에서 PASS / FAIL로 바뀜 — 그래서 이름을 채우는 것이 "장 PR 머지 뒤 재실행"의 첫 일
export const RPC = {
  // 지금 main에 있음
  find_profile: 'find_profile_by_handle',
  join_group: 'join_group_by_invite_code',
  regen_code: 'regenerate_invite_code',
  group_wake: 'get_group_wake_status',
  shared_alarms: 'get_shared_alarm_appointments',
  register_push_token: 'register_push_token',

  // 논리설계 이름이 정해진 것 (4장) — 입력 모양은 S1이 만든 뒤 맞춤
  block_user: 'block_user',
  unblock_user: 'unblock_user',

  // 아직 이름 없음 (2 · 3 · 5 · 6 · 7 · 8 · 9 · 10 · 12장)
  change_handle: null, // 2장 아이디 바꾸기 (30일 제한)
  friend_request: null, // 3장 요청 (직접 표 쓰기 닫힌 뒤)
  group_preview: null, // 5장 코드 입력 미리보기
  leave_group: null, // 5장 나가기
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
