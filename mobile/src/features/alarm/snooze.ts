// 울림 화면(H07) 미루기 칸 — 웹 미리보기(app/ring.tsx)가 그릴 값. 네이티브 울림 화면과 같은 규칙 (D3 기본안 A, docs/alarm-core.md)
//   5 · 10 · 15분 칩마다 "이만큼 미루면 출발보다 몇 분 늦는지", 한도에 닿았는지, 가장 짧은 미루기(5분)도 늦는지
//   늦는다고 막지 않고 보여 주기만 함. 계산은 알람 코어의 순수 함수
// 알람 코어의 순수 계산 파일만 직접 가져옴 (index는 네이티브 모듈을 찾으므로 — 같은 선례: lib/alarmSync 시험)
import { canSnooze, SNOOZE_MINUTES_OPTIONS, snoozeLateMinutes } from '../../../modules/alarm-core/src/plan';

import type { RingInfo } from './types';

export type SnoozeChip = { minutes: number; lateMinutes: number }; // lateMinutes 0 = 안 늦음

export type SnoozeView = {
  allowed: boolean; // 아직 더 미룰 수 있음 (한도 안)
  chips: SnoozeChip[];
  wakeNow: boolean; // 기상 알람이고 5분만 미뤄도 늦음 → 시각 위에 "지금 일어나야 … 출발에 맞아요" 띠
};

// 울린 시각(at)을 "지금"으로 봄 — 네이티브는 실제 현재 시각. 한도에 닿으면 늦어요는 보이지 않음 (미루기가 꺼져 있고 "지금 바로 준비" 안내가 대신함)
export function snoozeView(ring: Pick<RingInfo, 'kind' | 'at' | 'departAt' | 'snoozeCount' | 'snoozeLimit'>): SnoozeView {
  const allowed = canSnooze(ring.snoozeCount, ring.snoozeLimit);
  const departAt = ring.departAt?.getTime();
  const chips = SNOOZE_MINUTES_OPTIONS.map((minutes) => ({
    minutes,
    lateMinutes: allowed ? snoozeLateMinutes(ring.at.getTime(), minutes, departAt) : 0,
  }));
  return { allowed, chips, wakeNow: ring.kind === 'WAKE' && chips[0].lateMinutes > 0 };
}
