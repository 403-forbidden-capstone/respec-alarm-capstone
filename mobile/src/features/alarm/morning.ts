// 기상 후 아침 흐름 (이슈 #230 PR 1b) — H08 "오늘 첫 일정" 한 줄과 홈 아침 카드가 같이 쓰는 순수 계산
//   데이터를 읽지 않고 값만 받음 (시험: __tests__/morning.test.ts). 읽는 곳은 api.ts getMorningPlan · checkDepartNow
//   여유 · 상태 계산은 서버 알림 문구와 같은 공용 함수(@shared/calc/depart.ts, 7장 7.5.2)
import { departNow, type DepartStatus } from '@shared/calc/depart.ts';
import { hasEarlierWake } from '@shared/calc/wake.ts';

import { addDays, addMinutes, formatDuration, formatTime, minutesBetween, startOfDay } from '@/lib/format';

import { isEvening } from './schedule';
import type { AlarmTime, DepartCheck, MorningPlan } from './types';

// 출발 시각이 지나도 카드를 이만큼 더 둠 — 늦게 나서는 사람에게 지각 위험을 계속 보여 줌 (작성자 판단 — 이슈 #230)
export const MORNING_CARD_GRACE_MINUTES = 30;

export const DEPART_STATUS_LABEL: Record<DepartStatus, string> = { COMFORT: '여유', TIGHT: '빠듯', LATE_RISK: '지각 위험' };

// "오늘 첫 일정"을 고를 날 — 홈과 같음: 낮에는 오늘, 저녁(18시~)에는 내일 (새벽 약속의 기상 알람은 전날 밤에 울림)
export function morningDay(current: Date): Date {
  return startOfDay(isEvening(current) ? addDays(current, 1) : current);
}

// 낮이면 오늘, 저녁이면 내일 — H08 글자
export const morningDayWord = (current: Date) => (isEvening(current) ? '내일' : '오늘');

// 첫 일정을 고를 약속 한 줄 — 가짜 · 실데이터가 같은 모양으로 맞춰 넘김
export type MorningSource = {
  appointmentId: string;
  title: string;
  at: Date;
  place: string;
  travelMinutes: number;
  travelSource: string;
  alarms: readonly AlarmTime[]; // 이 약속의 알람 (꺼진 것 포함)
  departedAt: Date | null;
  arrivedAt: Date | null;
};

// 켜진 기상 알람
export const wakeAlarmOf = (source: Pick<MorningSource, 'alarms'>) => source.alarms.find((x) => x.kind === 'WAKE' && x.enabled);

// 그날 첫 일정 = 켜진 기상 알람이 붙은 약속 중 이 약속보다 앞선 기상이 없는 것 (서버 hasEarlierWake와 같은 기준 —
//   기상 알람은 그날 첫 일정에만 붙으므로 보통 하나. 약속 시각이 같으면 먼저 온 것). 하루 목록은 호출하는 쪽이 이미 그날로 걸러 넘김
export function pickMorningSource<T extends Pick<MorningSource, 'appointmentId' | 'at' | 'alarms'>>(list: readonly T[]): T | null {
  const withWake = list.filter((x) => wakeAlarmOf(x));
  const wakes = withWake.map((x) => ({ appointmentId: x.appointmentId, appointmentAt: x.at }));
  return [...withWake].sort((x, y) => x.at.getTime() - y.at.getTime()).find((x) => !hasEarlierWake(x.at, wakes, x.appointmentId)) ?? null;
}

export function toMorningPlan(source: MorningSource, wakeConfirmedAt: Date | null): MorningPlan | null {
  const wake = wakeAlarmOf(source);
  if (!wake) return null;
  const when = (kind: AlarmTime['kind']) => source.alarms.find((x) => x.kind === kind && x.enabled)?.at ?? null;
  return {
    appointmentId: source.appointmentId,
    title: source.title,
    at: source.at,
    place: source.place,
    wakeAlarmId: wake.id,
    wakeAt: wake.at,
    prepareAt: when('PREPARE'),
    departAt: when('DEPARTURE'),
    arriveAt: when('ARRIVE'),
    travelMinutes: source.travelMinutes,
    travelSource: source.travelSource,
    wakeConfirmedAt,
    departedAt: source.departedAt,
    arrivedAt: source.arrivedAt,
  };
}

// 출발 한계 시각 — 출발 알람이 있으면 그 시각, 없으면(꺼 둠) 약속 − 이동
export const departReference = (plan: Pick<MorningPlan, 'at' | 'departAt' | 'travelMinutes'>) => plan.departAt ?? addMinutes(plan.at, -plan.travelMinutes);

// 홈 아침 카드가 보이는 때: 오늘(저녁이 아님) · 기상 알람 시각부터 · 출발 시각 + 30분까지 · 출발 기록이 있으면 숨김
//   기상 확정(자동 판정 · "일어났어요")을 기다리지 않음 — 원탭을 기다리는 '확인 중' 상태를 만들지 않고 알람이 울린 때부터 바로 보여 줌
//     (지형님 10/29 흐름 확인(#240) + 7장 A~F 자동 수집 우선. 지시서의 "기상 확인 ~"을 알람 시각으로 넓힘)
//   알람 시각 전이라도 확정 기록이 있으면 보임 (가짜 모드의 시나리오 시계)
//   출발은 위치 감지 · 원탭 중 먼저 들어온 기록으로 숨기고, 기록이 없어도 출발 + 30분이 지나면 스스로 사라짐
export function morningCardVisible(plan: MorningPlan | null, current: Date): boolean {
  if (!plan || isEvening(current) || plan.departedAt != null) return false;
  const started = plan.wakeConfirmedAt != null || current.getTime() >= plan.wakeAt.getTime();
  return started && current.getTime() <= addMinutes(departReference(plan), MORNING_CARD_GRACE_MINUTES).getTime();
}

// 약속 시각이 지난 뒤에도 '이동 중' · '도착했어요' 줄을 이만큼 더 둠 (작성자 판단 — 11/19 지형님 "약속 + 60분")
export const TRIP_CARD_AFTER_MINUTES = 60;

export type TripCardView = {
  stage: 'MOVING' | 'ARRIVED';
  label: string; // 카드 위 라벨 — 이동 중 / 도착했어요
  title: string; // 오전 9:45 도착 예정 / 오전 9:48 (라벨과 같은 말이 겹치지 않게)
  summary: string; // 오전 10:00 팀 주간회의 · 세종대학교
};

// 홈 이동 중 · 도착 줄 — 출발 기록부터 도착 기록까지 '이동 중' 라벨 + '도착 예정'(출발 + 예상 이동분), 도착하면 '도착했어요'. 둘 다 약속 + 60분까지 (아침 카드는 출발하면 빠지므로 그 자리를 이음)
//   도착 기록이 있으면 출발 기록이 없어도 도착을 보임. 저녁(다음 날 일정을 보는 때)에는 없음
export function tripCardOf(plan: MorningPlan | null, current: Date): TripCardView | null {
  if (!plan || isEvening(current) || current.getTime() > addMinutes(plan.at, TRIP_CARD_AFTER_MINUTES).getTime()) return null;
  const summary = [`${formatTime(plan.at)} ${plan.title}`, plan.place].filter(Boolean).join(' · ');
  if (plan.arrivedAt) return { stage: 'ARRIVED', label: '도착했어요', title: formatTime(plan.arrivedAt), summary };
  if (plan.departedAt) return { stage: 'MOVING', label: '이동 중', title: `${formatTime(addMinutes(plan.departedAt, plan.travelMinutes))} 도착 예정`, summary };
  return null;
}

// 아직 안 울린 준비 · 출발 알림 (H08 "다음 알림")
export function upcomingNotices(plan: Pick<MorningPlan, 'prepareAt' | 'departAt'>, current: Date): { label: '준비' | '출발'; at: Date }[] {
  const list = [
    { label: '준비', at: plan.prepareAt },
    { label: '출발', at: plan.departAt },
  ] as const;
  return list.flatMap((x) => (x.at && x.at.getTime() > current.getTime() ? [{ label: x.label, at: x.at }] : []));
}

// ---------------------------------------------------------------------------
// 지금 나가면
// ---------------------------------------------------------------------------

// 지금(now)에 나서면 — 도착 = 지금 + 이동, 여유 = 약속 − 도착. 실데이터는 alarm-suggest로 이동분을 새로 구한 뒤 이 함수로 계산
export function toDepartCheck(input: { appointmentAt: Date; travelMinutes: number; source: string; now: Date }): DepartCheck {
  const { arriveAt, slackMinutes, status } = departNow({ appointmentAt: input.appointmentAt, travelMinutes: input.travelMinutes, now: input.now });
  return { travelMinutes: input.travelMinutes, source: input.source, arriveAt, slackMinutes, status, checkedAt: input.now };
}

// "지금 나가면 오전 9:47 도착 · 여유 13분" — 서버 출발 알림 글자(_shared/ring-package.ts departureNotice)와 같은 모양 (shared.test.ts가 같은 글자인지 봄)
export function departNowLine(arriveAt: Date, slackMinutes: number): string {
  const slack = slackMinutes > 0 ? `여유 ${formatDuration(slackMinutes)}` : slackMinutes === 0 ? '여유 없음' : `${formatDuration(-slackMinutes)} 늦어요`;
  return `지금 나가면 ${formatTime(arriveAt)} 도착 · ${slack}`;
}

export type MorningCardView = {
  summary: string; // 오전 10:00 전공 수업 · 세종대학교
  untilDepart: string | null; // 출발까지 1시간 10분 / 지금 출발할 시간이에요 / 출발 시각이 지났어요 / 출발 알람이 꺼져 있으면 null
  nowLine: string; // 지금 나가면 오전 9:47 도착 · 여유 13분
  status: DepartStatus;
  statusLabel: string; // 여유 · 빠듯 · 지각 위험
  travelLine: string; // 이동 50분 · 길찾기 · 오전 8:31 확인
};

// 카드에 그릴 글자. 이동분은 마지막으로 확인한 값(check)이 있으면 그것, 없으면 저장된 값 — 도착 · 여유는 늘 지금(current) 기준으로 다시 셈
export function morningCardView(plan: MorningPlan, check: DepartCheck | null, current: Date): MorningCardView {
  const travelMinutes = check?.travelMinutes ?? plan.travelMinutes;
  const source = check?.source ?? plan.travelSource;
  const now = departNow({ appointmentAt: plan.at, travelMinutes, now: current });
  const until = plan.departAt ? minutesBetween(current, plan.departAt) : null;
  return {
    summary: [`${formatTime(plan.at)} ${plan.title}`, plan.place].filter(Boolean).join(' · '),
    untilDepart: until == null ? null : until > 0 ? `출발까지 ${formatDuration(until)}` : until === 0 ? '지금 출발할 시간이에요' : '출발 시각이 지났어요',
    nowLine: departNowLine(now.arriveAt, now.slackMinutes),
    status: now.status,
    statusLabel: DEPART_STATUS_LABEL[now.status],
    travelLine: [`이동 ${travelMinutes}분`, source, check ? `${formatTime(check.checkedAt)} 확인` : ''].filter(Boolean).join(' · '),
  };
}
