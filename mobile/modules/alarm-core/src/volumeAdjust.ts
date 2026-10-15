// 평가로 볼륨 보정 (#81 · 상세설계 7장 7.4.3) — 순수 함수만. 평가를 받는 화면은 새 UI라 나중
// 규칙: 최근 평가 5번 중 "너무 시끄러워요"가 2번 이상이면 같은 강도 그대로 볼륨만 10% 줄임
//   결과는 RingPackage.volumeAdjust(비율)에 넣음 → plan.ts가 × (1 + volumeAdjust)로 반영
import type { AlarmFeedback } from './types';

export const RATING_WINDOW = 5;
export const TOO_LOUD_COUNT = 2;
export const TOO_LOUD_ADJUST = -0.1;

/**
 * ratings는 오래된 것 → 최근 순 (alarm_events FEEDBACK의 feedback_type).
 * 강도별로 나누지 않고 받은 목록 전체의 마지막 5개를 봄 — 강도별로 나눌지는 부르는 쪽이 목록을 걸러서 정함 (작성자 판단)
 * 누적되지 않음: 그때그때 최근 5번만 다시 세므로 −10%가 −20%로 쌓이지 않음
 */
export function volumeAdjustFromRatings(ratings: readonly AlarmFeedback[]): number {
  const loud = ratings.slice(-RATING_WINDOW).filter((rating) => rating === 'TOO_LOUD').length;
  return loud >= TOO_LOUD_COUNT ? TOO_LOUD_ADJUST : 0;
}
