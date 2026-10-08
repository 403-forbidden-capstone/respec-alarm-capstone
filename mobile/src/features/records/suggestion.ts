// S01 알람 조정 제안 — 화면에서 쓰는 상태 규칙 (목업 SCR.suggestion · A.sug*)
import type { SuggestionStatus } from './types';

// 화면 모양 세 가지 — 기다림(적용 · 직접 수정 · 무시) · 적용함(되돌리기) · 무시함(다시 보기)
export type SuggestionPhase = 'pending' | 'applied' | 'ignored';

export function suggestionPhase(status: SuggestionStatus): SuggestionPhase {
  if (status === 'APPLIED' || status === 'EDITED') return 'applied'; // 제안대로 · 직접 고쳐서 적용
  return status === 'IGNORED' ? 'ignored' : 'pending';
}

// 직접 수정 — 앞당길 분을 5분씩, 0~30분 (목업 A.sugStep)
export const EDIT_STEP = 5;
export const EDIT_MAX = 30;

export function stepMinutes(minutes: number, delta: number) {
  return Math.max(0, Math.min(EDIT_MAX, minutes + delta));
}
