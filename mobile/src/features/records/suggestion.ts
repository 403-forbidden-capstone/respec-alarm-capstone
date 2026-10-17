// S01 알람 조정 제안 — 화면에서 쓰는 상태 규칙 (목업 SCR.suggestion · A.sug*)
import { addMinutes } from '@/lib/format';

import type { EditBounds, Suggestion, SuggestionStatus } from './types';

// 화면 모양 세 가지 — 기다림(적용 · 직접 수정 · 무시) · 적용함(다시 수정 · 되돌리기) · 무시함(다시 보기)
export type SuggestionPhase = 'pending' | 'applied' | 'ignored';

export function suggestionPhase(status: SuggestionStatus): SuggestionPhase {
  if (status === 'APPLIED' || status === 'EDITED') return 'applied'; // 제안대로 · 직접 고쳐서 적용
  return status === 'IGNORED' ? 'ignored' : 'pending';
}

// 직접 수정 (D53) — 기상 알람을 1분씩. 값은 "적용 전보다 일찍(+) · 늦게(−) 몇 분"
export const EDIT_STEP = 1;
// 일찍 · 늦게 각각 최대 30분 — 목업 A.sugStep의 0~30을 양쪽으로 (D53은 폭을 정하지 않음, 작성자 판단)
export const EDIT_MAX = 30;

// 고를 수 있는 범위. 늦추는 쪽은 준비 알람이 출발 알람을 넘지 않게 (기상 ≤ 준비 ≤ 출발) — 출발은 약속에 묶여 그대로라
//   prepMinutes = 적용 전 예측 준비(분), beforePrepMinutes = 기상 뒤 준비 알람까지(분)
export function editBounds(prepMinutes: number, beforePrepMinutes: number): EditBounds {
  return { earlier: EDIT_MAX, later: Math.max(0, Math.min(EDIT_MAX, prepMinutes - beforePrepMinutes)) };
}

export function stepMinutes(minutes: number, delta: number, bounds: EditBounds) {
  return Math.max(-bounds.later, Math.min(bounds.earlier, minutes + delta)) || 0; // || 0 = -0을 0으로
}

// 미리 보기 — 적용 전 시각에서 minutes만큼 일찍(+) · 늦게(−): 기상 · 준비는 같이 움직이고 출발은 그대로
export function previewTimes(s: Pick<Suggestion, 'currentWake' | 'currentPrepare' | 'depart'>, minutes: number) {
  return {
    wake: addMinutes(s.currentWake, -minutes),
    prepare: s.currentPrepare ? addMinutes(s.currentPrepare, -minutes) : null,
    depart: s.depart,
  };
}

// 화면 글자 — "10분 일찍" · "5분 늦게" · 0이면 "그대로"
export function shiftText(minutes: number) {
  if (minutes === 0) return '그대로';
  return `${Math.abs(minutes)}분 ${minutes > 0 ? '일찍' : '늦게'}`;
}

// 기록 글자 — "10분 앞당김" · "5분 늦춤"
export function shiftLog(minutes: number) {
  return `${Math.abs(minutes)}분 ${minutes > 0 ? '앞당김' : '늦춤'}`;
}
