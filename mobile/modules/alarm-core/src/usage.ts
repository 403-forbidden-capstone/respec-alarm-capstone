// 화면 사용 구간 변환 (#35) — 순수 함수만
// 네이티브 getUsageSpans()는 시각(epoch ms) 구간을 돌려주고, 기상 판정(features/alarm/wake.ts)은
// "해제 뒤 몇 분" 구간(UseSpan)을 받음. 해제 시각을 빼서 분으로 바꾸기만 하면 같은 계산에 들어감
import type { UsageSpan } from './types';

/** features/alarm/wake.ts의 UseSpan과 같은 모양: [해제 뒤 시작 분, 끝 분] */
export type UseSpanMinutes = [start: number, end: number];

export function toUseSpans(spans: readonly UsageSpan[], dismissedAtMillis: number): UseSpanMinutes[] {
  return spans.map((span): UseSpanMinutes => [
    (span.startMillis - dismissedAtMillis) / 60_000,
    (span.endMillis - dismissedAtMillis) / 60_000,
  ]);
}
