// 저장 검증 — 상세설계서 8장 8.2.1 · 7장 7.1.4 (전체작업계획 4.1 Q1 표 "저장 검증")
//   · 알람 순서가 뒤집혔으면 막음 (F5 해석: 기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)
//   · 출발 시각이 지금보다 앞이면 저장 막음 (UNPROCESSABLE)
//   · 기상 · 준비 시각이 지금 + 5분보다 앞이면 그 알림만 끄고(is_enabled = false) 나머지는 저장
//     5분 여유는 8.2.1에만 있고 7.1.4에는 없음 → 문서 보완 목록 (Q1 표)
//   · 알람을 하나도 안 만든 일정(kinds = [])은 예약할 알람이 없어 시각 검사를 하지 않음 — 작성자 판단 (되돌리기 쉬움)
import { addMinutes } from './time.ts';
import { orderError } from './order.ts';
import type { ChainAlarm } from './types.ts';

export const PAST_GRACE_MINUTES = 5;

export type CheckedAlarm = ChainAlarm & {
  enabled: boolean; // false면 알람 행은 만들되 꺼 둠
  disabledReason?: 'PASSED';
};

export type CheckFailure = {
  ok: false;
  reason: 'ORDER' | 'DEPARTURE_PASSED' | 'ACTIVITY'; // ACTIVITY = 할 일 시각으로 기상 · 준비를 못 정함 (calc/day.ts, plan-core가 만듦)
  message: string; // 사용자에게 보일 짧은 이유
  detail?: { earlier: string; later: string } | Record<string, unknown>;
};

export type CheckResult = { ok: true; alarms: CheckedAlarm[] } | CheckFailure;

// alarms = alarmChain 결과(만든 종류만), departure = 출발 시각(DEPARTURE 알람을 안 만들어도 있음)
export function checkAlarms(alarms: readonly ChainAlarm[], departure: Date, now: Date): CheckResult {
  if (alarms.length === 0) return { ok: true, alarms: [] }; // 알람 없는 일정
  const order = orderError(alarms);
  if (order) return { ok: false, reason: 'ORDER', message: order.message, detail: { earlier: order.earlier, later: order.later } };
  if (departure.getTime() < now.getTime()) {
    return { ok: false, reason: 'DEPARTURE_PASSED', message: '출발 시각이 이미 지나서 저장할 수 없어요' };
  }
  const limit = addMinutes(now, PAST_GRACE_MINUTES).getTime();
  return {
    ok: true,
    alarms: alarms.map((x) => {
      const passed = (x.kind === 'WAKE' || x.kind === 'PREPARE') && x.at.getTime() < limit;
      return passed ? { ...x, enabled: false, disabledReason: 'PASSED' } : { ...x, enabled: true };
    }),
  };
}
