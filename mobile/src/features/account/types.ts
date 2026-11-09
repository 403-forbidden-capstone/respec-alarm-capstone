// 설정 > [계정 삭제] 확인 문구용 — my_account_delete_summary (본인 것만)
export type DeleteSummary = {
  groupsLeaving: number; // 나갈 그룹 수
  groupsDisappearing: number; // 그중 내가 마지막 멤버라 사라질 그룹 수
  groupAppointmentsStaying: number; // 내가 만들어 남을 공동 약속 수
  friends: number; // 친구 수
};

// account-delete 응답 — deleted true일 때만 계정이 지워진 것
export type DeleteResult = { groupsLeft: number; groupsDeleted: number; groupAppointmentsKept: number };
