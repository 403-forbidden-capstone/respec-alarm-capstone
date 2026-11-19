// Web/dev experiment: deterministic calculation only. Never writes DB or
// schedules a native alarm. It uses the SAME pure-prep adapter as the server.
import { purePrepAlarmChain } from '@shared/calc/pure-prep.ts';
import type { AlarmKind } from '@shared/calc/types.ts';

export const DEMO_APPOINTMENT = new Date('2026-11-22T01:00:00.000Z'); // 10:00 KST
export type PurePrepScenarioInput = {
  pureMinutes: number;
  travelMinutes: number;
  bufferMinutes: number;
  preTaskMinutes: number;
  wakeLeadMinutes: number;
  withWake: boolean;
};
export const DEFAULT_PURE_SCENARIO: PurePrepScenarioInput = {
  pureMinutes: 35,
  travelMinutes: 30,
  bufferMinutes: 10,
  preTaskMinutes: 0,
  wakeLeadMinutes: 20,
  withWake: true,
};
export type PurePrepScenarioResult = Partial<Record<AlarmKind, Date>>;
export function calculatePurePrepScenario(i: PurePrepScenarioInput): PurePrepScenarioResult {
  const rows = purePrepAlarmChain({
    at: DEMO_APPOINTMENT,
    purePrepMinutes: i.pureMinutes,
    travelMinutes: i.travelMinutes,
    bufferMinutes: i.bufferMinutes,
    prePrepTaskMinutes: i.preTaskMinutes,
    wakeLeadMinutes: i.wakeLeadMinutes,
    withWake: i.withWake,
  });
  return Object.fromEntries(rows.map((row) => [row.kind, row.at])) as PurePrepScenarioResult;
}
export function kstHm(at: Date | undefined): string {
  if (!at) return '없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}
