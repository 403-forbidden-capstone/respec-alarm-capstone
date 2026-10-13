// 기상 판정 계산 (H08) — 데이터를 읽지 않는 순수 함수만 (api.ts와 나눠서 단위 테스트)
// 화면 사용은 "해제 뒤 몇 분부터 몇 분까지 켜져 있었는지" 구간 목록으로 받음
//   실데이터(#40 사용 정보 접근: 화면 켜짐 · 잠금 해제 시각)도 해제 시각을 빼서 이 구간으로 바꿔 넣으면 같은 계산
import { addMinutes } from '@/lib/format';

import { WAKE_OBSERVE_MINUTES, WAKE_RECENT_MINUTES } from './types';

export type UseSpan = readonly [start: number, end: number]; // 해제 뒤 분 (start ≤ end)

// 관찰 시간(0 ~ limit분) 안으로 자르고, 시각순으로 겹치는 구간을 합침 — 같은 시간을 두 번 세지 않게
function clean(spans: readonly UseSpan[], limit: number): [number, number][] {
  const sorted = spans
    .map(([s, e]): [number, number] => [Math.max(0, s), Math.min(limit, e)])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// from ~ to분 사이 화면 사용 합 (분)
export function usedMinutes(spans: readonly UseSpan[], from: number, to: number): number {
  return clean(spans, to).reduce((sum, [s, e]) => sum + Math.max(0, e - Math.max(s, from)), 0);
}

// H08 막대 두 개 — 누적 사용(해제 후 10분) · 최근 사용(뒤쪽 5분), 소수 첫째 자리
export function usageSummary(spans: readonly UseSpan[], observeMinutes = WAKE_OBSERVE_MINUTES) {
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    usage: round(usedMinutes(spans, 0, observeMinutes)),
    recent: round(usedMinutes(spans, observeMinutes - WAKE_RECENT_MINUTES, observeMinutes)),
  };
}

// 누적 사용이 θ에 닿은 시각 (D14) — 기상 확정 시각으로 기록. 관찰 시간 안에 못 닿으면 null
// 판정은 관찰이 끝나야 하지만, 기록은 실제로 일어난 시각에 가까운 이 시각으로 거꾸로 남김
export function thetaReachedAt(
  dismissedAt: Date,
  spans: readonly UseSpan[],
  thetaMinutes: number,
  observeMinutes = WAKE_OBSERVE_MINUTES,
): Date | null {
  let used = 0;
  for (const [s, e] of clean(spans, observeMinutes)) {
    if (used + (e - s) >= thetaMinutes) return addMinutes(dismissedAt, s + Math.max(0, thetaMinutes - used));
    used += e - s;
  }
  return null;
}
