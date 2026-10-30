// 출발 여유(slack) — 상세설계서 7장 7.5.2. 기상 뒤 "지금 이 속도면 늦지 않게 나갈 수 있나"를 세 칸으로 나눔
//   latest_departure = 약속 − 이동   (여유시간까지 다 쓴 출발 한계 — 약속 앞 여유(buffer)를 빼지 않음)
//   slack = latest_departure − (지금 + 남은 준비분)
//   slack ≥ 10 → 여유 / 0 ≤ slack < 10 → 빠듯 / slack < 0 → 지각 위험
// 분 단위는 minutesBetween(반올림)을 따름. 출발 알람 문구(ring-package.ts)와 기상 뒤 화면이 같은 함수를 씀
import { addMinutes, minutesBetween } from './time.ts';

// 7장 7.5.2 — 이 분 이상 남으면 여유, 0 이상 이만큼 미만이면 빠듯, 0 미만이면 지각 위험
export const DEPART_COMFORT_MIN_SLACK = 10;
export const DEPART_TIGHT_MIN_SLACK = 0;

export const DEPART_STATUS = { COMFORT: 'COMFORT', TIGHT: 'TIGHT', LATE_RISK: 'LATE_RISK' } as const;
export type DepartStatus = (typeof DEPART_STATUS)[keyof typeof DEPART_STATUS];

export function departStatus(slackMinutes: number): DepartStatus {
  if (slackMinutes >= DEPART_COMFORT_MIN_SLACK) return DEPART_STATUS.COMFORT;
  if (slackMinutes >= DEPART_TIGHT_MIN_SLACK) return DEPART_STATUS.TIGHT;
  return DEPART_STATUS.LATE_RISK;
}

export type DepartSlackInput = {
  appointmentAt: Date;
  travelMinutes: number;
  now: Date;
  remainingMinutes: number; // 나가기 전까지 남은 준비 (분). 지금 나가면 0
};

// 지금 시작해서 남은 준비를 마치고 나가도 되는 만큼의 여유 (음수면 이미 늦음)
export function departSlack(input: DepartSlackInput): { slackMinutes: number; status: DepartStatus } {
  const latestDeparture = addMinutes(input.appointmentAt, -input.travelMinutes);
  const readyAt = addMinutes(input.now, input.remainingMinutes);
  const slackMinutes = minutesBetween(readyAt, latestDeparture) + 0; // 반올림이 낸 -0을 0으로 (+ 0)
  return { slackMinutes, status: departStatus(slackMinutes) };
}

// 지금 바로 나가면 (남은 준비 0): 도착 시각과 약속까지의 여유 (slack = 약속 − 도착)
export function departNow(input: Omit<DepartSlackInput, 'remainingMinutes'>): { arriveAt: Date; slackMinutes: number; status: DepartStatus } {
  const { slackMinutes, status } = departSlack({ ...input, remainingMinutes: 0 });
  return { arriveAt: addMinutes(input.now, input.travelMinutes), slackMinutes, status };
}
