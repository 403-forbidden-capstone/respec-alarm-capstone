// 약속 붙이기 — 받은 이탈 · 진입이 어느 참여 조건의 출발 · 도착인지
//   · 집 이탈 → 오늘 첫 약속(출발지 = 집) — L6 안건후보: 집 이탈 약속 붙이기 기본안 A
//       집은 창 없이 늘 감시라(D68) 약속과 상관없는 외출도 들어옴 → 도착 전 귀가면 transitions가 다음 이탈로 바꿀 수 있게 둠 (앞 출발은 '확인할 기록', 7.13.7)
//       오늘 = 이탈 시각의 한국 날짜(lib/format dayKey, 0시 경계 — daily_records.record_date와 같음), 첫 = 약속 시각 이른 순 (같으면 출발 예정 · id 순)
//       건너뜀: 이미 출발이 있음, 이미 도착이 있음(아래 예외 빼고), 창이 끝남(약속 60분 후 지남), 오늘 약속이 아님
//   · 집 아닌 출발지 이탈 → 그곳에서 출발하는 참여 조건 중 창 안 · 아직 출발 · 도착 없는 첫 약속 하나
//   · 도착이 먼저 잡혔고 출발이 없는 약속 — 이탈이 그 도착 전이거나 도착 뒤 30분 안이면 그 약속의 출발로 붙임 (다른 약속에 안 감)
//       가까운 약속은 두 영역이 겹치거나 신호가 늦게 와서 목적지 진입이 출발지 이탈보다 먼저 올 수 있고, 원탭 "도착했어요"가 이탈 신호보다 먼저 들어올 수 있음
//       (30분은 같은 길과 같은 값 — 근거 없음, 작성자 판단)
//   · 같은 길 — 그 출발지에서 떠나는 약속의 출발이 이탈 앞뒤 30분 안에 이미 있으면(원탭 "출발했어요" 등) 아무 약속에도 안 붙임
//   · 목적지 진입 → 그곳이 목적지인 참여 조건 중 창 안 · 아직 도착 없는 것 모두 (같은 건물 연달아 있는 약속)
//       500m 안 가까운 약속도 받음 — D68은 이동 측정만 끔 (안건후보 D78 정리, regions.ts)
import { dayKey } from '@/lib/format';

import { minutesMs, SAME_TRIP_MINUTES } from './constants';
import { detectionWindow, type MonitoredRegion, type TrackedParticipant } from './regions';

// 이미 출발 · 도착이 있는 참여 조건 (계획 때 DB 값 + 그 뒤 위치로 잡은 것, transitions가 만듦). arrived = 참여 조건 → 도착 시각
export type Taken = { departed: ReadonlySet<string>; arrived: ReadonlyMap<string, number> };
// 이미 있는 출발 (DB 값 중 지우지 않은 것 + 위치로 잡은 것 · 대기 중인 것, transitions가 만듦)
export type KnownDeparture = { participantId: string; at: number };

const SAME_TRIP_MS = minutesMs(SAME_TRIP_MINUTES);

const order = (a: TrackedParticipant, b: TrackedParticipant) =>
  a.appointmentAt - b.appointmentAt || a.departAt - b.departAt || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);

// 이 이탈을 출발로 붙일 수 있는지 — 아직 출발이 없고, 도착이 없거나 이탈이 그 도착 전 · 도착 뒤 30분 안 (위 머리 주석)
const departable = (p: TrackedParticipant, taken: Taken, at: number) => {
  if (taken.departed.has(p.participantId)) return false;
  const arrivedAt = taken.arrived.get(p.participantId);
  return arrivedAt == null || at <= arrivedAt + SAME_TRIP_MS;
};
const inWindow = (p: TrackedParticipant, at: number) => {
  const { start, end } = detectionWindow(p);
  return start <= at && at <= end;
};
const sameDay = (p: TrackedParticipant, at: number) => dayKey(new Date(p.appointmentAt)) === dayKey(new Date(at));

// participants에 감지 안 하는 약속(plan.untracked)도 넣어 부름 — 그 약속이 첫 약속이면 그 id를 돌려주고,
//   부른 쪽은 판정 목록에 없으니 판정 없이 끝냄 (그 약속 몫의 이탈이 다음 약속에 붙지 않게)
export function attachHomeExit(participants: readonly TrackedParticipant[], at: number, taken: Taken): string | null {
  const found = participants.filter((p) => p.fromHome && departable(p, taken, at) && at <= detectionWindow(p).end && sameDay(p, at)).sort(order);
  return found[0]?.participantId ?? null;
}

export function attachOriginExit(region: MonitoredRegion, participants: readonly TrackedParticipant[], at: number, taken: Taken): string | null {
  const found = participants.filter((p) => region.originOf.includes(p.participantId) && departable(p, taken, at) && inWindow(p, at)).sort(order);
  return found[0]?.participantId ?? null;
}

// 같은 길인지 — 원탭 "출발했어요" 뒤 집을 나선 이탈이 다음 약속에 붙지 않게 (7.20 실폰 측정 전 기본값 30분)
//   집:오늘 약속 중 출발지 = 집 (감지 안 하는 약속 포함), 집 아닌 출발지: 그곳에서 출발하는 참여 조건. 앞뒤 30분 양 끝 포함
export function isSameTrip(region: MonitoredRegion, participants: readonly TrackedParticipant[], departures: readonly KnownDeparture[], at: number): boolean {
  const fromHere = new Set(
    participants.filter((p) => (region.home ? p.fromHome && sameDay(p, at) : region.originOf.includes(p.participantId))).map((p) => p.participantId),
  );
  return departures.some((d) => fromHere.has(d.participantId) && Math.abs(d.at - at) <= SAME_TRIP_MS);
}

export function attachDestEnter(region: MonitoredRegion, participants: readonly TrackedParticipant[], at: number, taken: Taken): string[] {
  return participants
    .filter((p) => region.destOf.includes(p.participantId) && !taken.arrived.has(p.participantId) && inWindow(p, at))
    .sort(order)
    .map((p) => p.participantId);
}
