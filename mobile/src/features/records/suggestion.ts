// S01 알람 조정 제안 — 화면에서 쓰는 상태 규칙 (목업 SCR.suggestion · A.sug*)
import { addMinutes, formatTime } from '@/lib/format';

import type { EditBounds, Suggestion, SuggestionStatus } from './types';

// 화면 모양 세 가지 — 기다림(적용 · 직접 수정 · 무시) · 적용함(다시 수정 · 되돌리기) · 무시함(다시 보기)
export type SuggestionPhase = 'pending' | 'applied' | 'ignored';

export function suggestionPhase(status: SuggestionStatus): SuggestionPhase {
  if (status === 'APPLIED' || status === 'EDITED') return 'applied'; // 제안대로 · 직접 고쳐서 적용
  return status === 'IGNORED' ? 'ignored' : 'pending';
}

// 직접 수정 (D53) — 준비 알람을 1분씩. 값은 "적용 전보다 일찍(+) · 늦게(−) 몇 분"
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

// 미리 보기 — 적용 전 시각에서 준비 알람을 minutes만큼 일찍(+) · 늦게(−) (안건 D111 1 · 2번, 서버 calc/chain.ts · suggest-apply.ts와 같은 규칙)
//   준비 전 활동(기상 → 준비 간격)에서 먼저 가져오고, 모자란 만큼만 기상도 앞당김. 늦추면 기상은 그대로. 출발은 그대로
//   준비 알람이 없는 일정은 기상을 움직임 (예전 규칙)
export function previewTimes(s: Pick<Suggestion, 'currentWake' | 'currentPrepare' | 'depart'>, minutes: number) {
  if (!s.currentPrepare) return { wake: addMinutes(s.currentWake, -minutes), prepare: null, depart: s.depart };
  const gap = Math.max(0, Math.round((s.currentPrepare.getTime() - s.currentWake.getTime()) / 60_000));
  return {
    wake: addMinutes(s.currentWake, -Math.max(0, minutes - gap)),
    prepare: addMinutes(s.currentPrepare, -minutes),
    depart: s.depart,
  };
}

// 준비 알람 당김의 직접 수정 범위 — 더 당기는 쪽만(서버 suggestion-apply EDIT), 당김 합은 120분까지(#484 칸 범위). advance = 이번 제안 전 당김 분
export const MAX_ADVANCE_MINUTES = 120;
export function prepareBounds(advance: number): EditBounds {
  return { earlier: Math.max(0, Math.min(EDIT_MAX, MAX_ADVANCE_MINUTES - advance)), later: 0 };
}

// 준비 알람 당김에서 기상이 움직이는지 — 준비 전 활동 안이면 그대로, 넘으면 넘친 만큼 (S01 제안 카드 한 줄)
export function wakeLine(before: Date, after: Date) {
  const minutes = Math.round((before.getTime() - after.getTime()) / 60_000);
  return minutes > 0 ? `기상 알람도 ${minutes}분 앞당겨져요.` : '기상 알람은 그대로예요.';
}

// 대화 카드 한 줄 (A02 저녁 대화, 안건 D111 5번) — "준비 오전 7:30 → 오전 7:20 · 기상 알람은 그대로예요." 준비 알람이 없으면 기상
export function promptLine(s: Pick<Suggestion, 'currentWake' | 'currentPrepare' | 'proposedWake' | 'proposedPrepare'>) {
  if (!s.currentPrepare || !s.proposedPrepare) return `기상 ${formatTime(s.currentWake)} → ${formatTime(s.proposedWake)}`;
  return `준비 ${formatTime(s.currentPrepare)} → ${formatTime(s.proposedPrepare)} · ${wakeLine(s.currentWake, s.proposedWake)}`;
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
