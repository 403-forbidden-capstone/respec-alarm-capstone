// 약속 붙이기 — 받은 이탈 · 진입이 어느 참여 조건의 출발 · 도착인지
//   · 집 이탈 → 오늘 첫 약속(출발지 = 집) — D79 기본안 A. 집은 창 없이 늘 감시라 약속과 상관없는 외출도 들어옴 → 도착 전 귀가면 transitions가 지움
//       오늘 = 이탈 시각의 한국 날짜(lib/format dayKey, 0시 경계 — daily_records.record_date와 같음), 첫 = 약속 시각 이른 순 (같으면 출발 예정 · id 순)
//       건너뜀: 이미 출발 · 도착이 있음, 창이 끝남(약속 60분 후 지남), 오늘 약속이 아님
//   · 집 아닌 출발지 이탈 → 그곳에서 출발하는 참여 조건 중 창 안 · 아직 출발 · 도착 없는 첫 약속 하나
//   · 목적지 진입 → 그곳이 목적지인 참여 조건 중 창 안 · 아직 도착 없는 것 모두 (같은 건물 연달아 있는 약속)
import { dayKey } from '@/lib/format';

import { detectionWindow, type MonitoredRegion, type TrackedParticipant } from './regions';

// 이미 출발 · 도착이 있는 참여 조건 (계획 때 DB 값 + 그 뒤 위치로 잡은 것, transitions가 만듦)
export type Taken = { departed: ReadonlySet<string>; arrived: ReadonlySet<string> };

const order = (a: TrackedParticipant, b: TrackedParticipant) =>
  a.appointmentAt - b.appointmentAt || a.departAt - b.departAt || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);

const free = (p: TrackedParticipant, taken: Taken) => !taken.departed.has(p.participantId) && !taken.arrived.has(p.participantId);
const inWindow = (p: TrackedParticipant, at: number) => {
  const { start, end } = detectionWindow(p);
  return start <= at && at <= end;
};

export function attachHomeExit(participants: readonly TrackedParticipant[], at: number, taken: Taken): string | null {
  const today = dayKey(new Date(at));
  const found = participants
    .filter((p) => p.fromHome && free(p, taken) && at <= detectionWindow(p).end && dayKey(new Date(p.appointmentAt)) === today)
    .sort(order);
  return found[0]?.participantId ?? null;
}

export function attachOriginExit(region: MonitoredRegion, participants: readonly TrackedParticipant[], at: number, taken: Taken): string | null {
  const found = participants.filter((p) => region.originOf.includes(p.participantId) && free(p, taken) && inWindow(p, at)).sort(order);
  return found[0]?.participantId ?? null;
}

export function attachDestEnter(region: MonitoredRegion, participants: readonly TrackedParticipant[], at: number, taken: Taken): string[] {
  return participants
    .filter((p) => region.destOf.includes(p.participantId) && !p.near && !taken.arrived.has(p.participantId) && inWindow(p, at))
    .sort(order)
    .map((p) => p.participantId);
}
