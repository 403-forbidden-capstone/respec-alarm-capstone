// 알람 화면이 같이 쓰는 순수 계산 — 데이터를 읽지 않고 시각만 받음 (단위 테스트)
//   H01 다음 알람 카드 · H02 날짜 묶음 · H03 바뀌는 알람 · H05 처음 시각 · 울릴 알람 수
import { addDays, addMinutes, dayKey, formatDateShort, minuteOfDay, minutesBetween, startOfDay } from '@/lib/format';

import { KIND_LABEL, type AlarmKind, type AlarmTime, type Appointment } from './types';

// 저녁(오후 6시부터)에는 홈이 내일을 보여 줌 — 홈이 18시에 바뀌는 것은 D13
export const EVENING_START_MINUTE = 18 * 60;

export function isEvening(t: Date) {
  return minuteOfDay(t) >= EVENING_START_MINUTE;
}

export const isPassed = (alarm: AlarmTime, current: Date) => alarm.at.getTime() < current.getTime();

// 울리는 알람 — 도착 목표는 울리지 않는 시각이라 뺌
export const ringingKinds = (alarms: AlarmTime[]) => alarms.filter((x) => x.kind !== 'ARRIVE');

// 앞으로 울릴 알람 (켜져 있고 아직 안 지난 것) — 저장 토스트의 "알람 N개"는 칩에 지남이 안 붙은 이 개수
export function upcomingAlarms(alarms: AlarmTime[], current: Date) {
  return ringingKinds(alarms).filter((x) => x.enabled && !isPassed(x, current));
}

// 카드의 큰 시각 — 앞으로 울릴 첫 알람 (홈 "N분 뒤"와 같은 것). 다 지났으면 켜진 첫 알람을 "지남"으로, 다 껐으면 첫 알람
export function pickCardAlarm(alarms: AlarmTime[], current: Date): { alarm: AlarmTime; passed: boolean } {
  const list = ringingKinds(alarms);
  const next = list.find((x) => x.enabled && !isPassed(x, current));
  if (next) return { alarm: next, passed: false };
  const enabled = list.find((x) => x.enabled);
  if (enabled) return { alarm: enabled, passed: true };
  return { alarm: list[0], passed: false };
}

// 카드 오른쪽 줄 글자 — 꺼진 알람은 "꺼짐", 지난 알람은 "지남"
export function chainLabel(alarm: AlarmTime, current: Date, time: string) {
  const mark = !alarm.enabled ? ' · 꺼짐' : isPassed(alarm, current) ? ' · 지남' : '';
  return `${time} ${KIND_LABEL[alarm.kind]}${mark}`;
}

// 오늘 0시부터 — 오늘 일정은 시각이 지났어도 "예정"에 둠
export function splitUpcoming(list: Appointment[], current: Date) {
  const todayKey = dayKey(current);
  const upcoming: Appointment[] = [];
  const past: Appointment[] = [];
  for (const a of list) (dayKey(a.at) >= todayKey ? upcoming : past).push(a);
  return { upcoming, past };
}

// 날짜 묶음 제목 — 오늘 · 5월 22일 (목) / 내일 · 5월 23일 (금) / 5월 24일 (토)
export function dayHeading(day: Date, current: Date) {
  const diff = minutesBetween(startOfDay(current), startOfDay(day)) / (24 * 60);
  const base = formatDateShort(day);
  if (diff === 0) return `오늘 · ${base}`;
  if (diff === 1) return `내일 · ${base}`;
  return base;
}

// 날짜별로 묶음 (시각 순은 호출하는 쪽이 맞춰 둠)
export function groupByDay(list: Appointment[]) {
  const days = new Map<string, Appointment[]>();
  for (const a of list) days.set(dayKey(a.at), [...(days.get(dayKey(a.at)) ?? []), a]);
  return [...days.values()];
}

// 저장하면 시각이 바뀌는 알람 (기상 · 준비 · 출발) — 확인 시트에 전부 보여 줌
export type AlarmChange = { kind: AlarmKind; from: Date; to: Date };

export function changedAlarms(before: AlarmTime[], after: AlarmTime[]): AlarmChange[] {
  return ringingKinds(after).flatMap((next) => {
    const prev = before.find((x) => x.kind === next.kind);
    return prev && minutesBetween(prev.at, next.at) !== 0 ? [{ kind: next.kind, from: prev.at, to: next.at }] : [];
  });
}

// ?date=2025-05-22 → 그날 0시. 형식이 틀리거나 없는 날짜면 null
export function parseDayParam(value: string | undefined): Date | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60_000);
  return dayKey(date) === value ? date : null;
}

// 새 일정 처음 시각 — 오후 2시, 그 시각이 이미 지났으면 다음 정각 (자정을 넘으면 그날 마지막 분)
export function initialTime(day: Date, current: Date) {
  const base = startOfDay(day);
  const at2pm = addMinutes(base, 14 * 60);
  if (at2pm.getTime() > current.getTime()) return '14:00';
  const nextHour = Math.floor(minuteOfDay(current) / 60) + 1;
  const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  // 다른 날(지난 날)은 판단하지 않음 — 날짜 고르기가 오늘 앞을 막음
  if (dayKey(base) !== dayKey(current)) return '14:00';
  return nextHour >= 24 ? hm(23, 59) : hm(nextHour, 0);
}

// 내일 (홈에서 오지 않은 새 일정의 처음 날짜)
export const tomorrow = (current: Date) => addDays(startOfDay(current), 1);

// 준비물 입력 한 줄을 목록에 더함 — 쉼표로 여러 개를 한 번에 적어도 나뉘고, 빈 값 · 같은 이름은 건너뜀
export function addItems(list: string[], text: string) {
  const next = [...list];
  for (const raw of text.split(',')) {
    const name = raw.trim();
    if (name && !next.includes(name)) next.push(name);
  }
  return next;
}

// 날짜 + 시간 칸('14:00') → 시각. 시간이 비었거나 형식이 틀리면 목업처럼 14:00
export function draftAt(date: Date, time: string): Date {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return addMinutes(startOfDay(date), match ? Number(match[1]) * 60 + Number(match[2]) : 14 * 60);
}

// 같은 날 앞선 일정의 켜진 기상 알람 — 있으면 이 약속은 기상 없이 준비부터 (서버 · 목업 계산의 hasEarlierWake와 같은 기준: 약속 시각이 앞선 것만, 꺼 둔 일정 · 꺼 둔 기상은 안 셈)
// 일정 없는 알람(실데이터 D46, standalone)은 서버가 약속 참여만 세므로 여기서도 안 셈
// H05가 "같은 날 수업 기상 알람(오전 7:20)으로 깨워요" 한 줄에 씀. 둘 이상이면 가장 이른 약속의 것
export function earlierWakeOf(at: Date, appointments: readonly Appointment[], ownId?: string): { title: string; at: Date } | null {
  const earlier = appointments
    .filter((a) => a.id !== ownId && !a.standalone && a.enabled && dayKey(a.at) === dayKey(at) && a.at.getTime() < at.getTime())
    .sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const a of earlier) {
    const wake = a.alarms.find((x) => x.kind === 'WAKE' && x.enabled);
    if (wake) return { title: a.title, at: wake.at };
  }
  return null;
}
