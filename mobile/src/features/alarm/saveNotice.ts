// 저장 뒤처리 실패 문구 — 저장(alarm-commit)은 됐으니 "저장 못 함"이 아니라 "저장했지만 ~못 했어요" (realPlan.ts 저장 함수들의 followUp)
//   폰에 못 건 알람은 다음 맞추기(앱이 앞에 올 때)에서 다시 걸리고 그때까지 홈 빨간 줄(permissions/banner.ts)에 남음 → 홈 안내로 보냄
//   뒤처리가 다 됐으면 null — 화면은 원래 저장 문구를 씀
import type { SaveFollowUp } from './types';

export function saveNotice(followUp: SaveFollowUp | undefined, lead = '일정은 저장했지만'): string | null {
  if (!followUp) return null;
  const { phoneFailed, itemsFailed } = followUp;
  if (phoneFailed > 0) return `${lead} 알람 ${phoneFailed}개를 폰에 걸지 못했${itemsFailed ? '고 준비물도 저장하지 못했' : ''}어요. 홈 안내를 확인해 주세요`;
  if (itemsFailed) return `${lead} 준비물은 저장하지 못했어요`;
  return null;
}

// 여러 번 저장한 결과를 한 문구로 (시간표의 수업 여러 개) — 못 건 수는 더하고 준비물은 하나라도 못 넣었으면
export function mergeFollowUps(list: readonly (SaveFollowUp | undefined)[]): SaveFollowUp | undefined {
  const phoneFailed = list.reduce((sum, f) => sum + (f?.phoneFailed ?? 0), 0);
  const itemsFailed = list.some((f) => f?.itemsFailed === true);
  return phoneFailed > 0 || itemsFailed ? { phoneFailed, itemsFailed } : undefined;
}
