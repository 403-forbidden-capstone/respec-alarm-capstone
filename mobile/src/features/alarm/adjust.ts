// 알람 시각을 직접 고르기 (H03 · H05 확인 시트, D42 C · D43) — 순수 계산만, 단위 테스트는 __tests__/adjust.test.ts
// 규칙 (전체작업계획 8.1 F5 해석):
//   · 직접 고른 시각은 "직접 고름"으로 표시하고 자동 계산보다 먼저 씀 (강도 직접 고르기와 같은 규칙). 자동 계산값과 같아지면 다시 자동
//   · 기상을 옮기면 준비도 같은 간격으로 따라옴. 출발 · 도착 목표는 약속에 묶여 그대로
//   · 순서(기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)가 뒤집히면 저장을 막음
import { formatTime } from '@/lib/format';

import { KIND_LABEL, type AlarmEdits, type AlarmTime, type Estimate, type RingKind } from './types';

const ORDER = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'] as const;

// 자동으로 계산했다면 이 시각 — 직접 고르지 않았으면 지금 시각
export const autoTime = (x: AlarmTime) => x.auto ?? x.at;

// 직접 고른 시각인지
export const isManualTime = (x: AlarmTime) => x.auto != null;

// 시각을 바꾼 알람 — 자동 계산값과 같으면 직접 고른 것이 아님
function withTime(x: AlarmTime, at: Date): AlarmTime {
  const base = autoTime(x);
  const next: AlarmTime = { ...x, at };
  if (at.getTime() === base.getTime()) delete next.auto;
  else next.auto = base;
  return next;
}

// 자동 계산값까지 같이 옮김 — 기상을 옮기면 따라오는 준비 알람 (준비의 자동값도 기상 뒤로 계산하므로)
function shifted(x: AlarmTime, ms: number): AlarmTime {
  const move = (d: Date) => new Date(d.getTime() + ms);
  return { ...x, at: move(x.at), ...(x.auto ? { auto: move(x.auto) } : {}) };
}

// kind 알람을 to로 옮김. 기상이면 준비 알람도 같은 간격만큼 같이 옮김
export function moveAlarm(alarms: AlarmTime[], kind: RingKind, to: Date): AlarmTime[] {
  const target = alarms.find((x) => x.kind === kind);
  if (!target) return alarms;
  const delta = to.getTime() - target.at.getTime();
  return alarms.map((x) => {
    if (x.kind === kind) return withTime(x, to);
    if (kind === 'WAKE' && x.kind === 'PREPARE') return shifted(x, delta);
    return x;
  });
}

// 직접 고른 시각을 자동 계산값으로 되돌림 (기상이면 따라온 준비도 함께 되돌아감)
export function resetAlarm(alarms: AlarmTime[], kind: RingKind): AlarmTime[] {
  const target = alarms.find((x) => x.kind === kind);
  return target ? moveAlarm(alarms, kind, autoTime(target)) : alarms;
}

// 직접 고른 시각만 모음 (H03 초안 · 저장할 값) — 없는 종류는 자동
export function manualTimes(alarms: AlarmTime[]): Partial<Record<RingKind, Date>> {
  const times: Partial<Record<RingKind, Date>> = {};
  for (const x of alarms) if (x.kind !== 'ARRIVE' && x.auto) times[x.kind] = x.at;
  return times;
}

// 순서가 뒤집혔으면 사용자에게 보일 짧은 이유, 맞으면 null — 저장을 막을 때 씀
// 기상 ≤ 준비 ≤ 출발 ≤ 도착 목표 (같은 시각은 허용). 만든 알람만 비교
export function orderError(alarms: AlarmTime[]): string | null {
  const sorted = ORDER.flatMap((kind) => alarms.filter((x) => x.kind === kind));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (next.at.getTime() >= prev.at.getTime()) continue;
    return next.kind === 'ARRIVE'
      ? `${KIND_LABEL[prev.kind]} 시각이 도착 목표(${formatTime(next.at)})보다 늦을 수 없어요`
      : `${KIND_LABEL[next.kind]} 시각이 ${KIND_LABEL[prev.kind]}보다 빠를 수 없어요`;
  }
  return null;
}

// H05 확인 시트에서 알람 시각을 고침 — to가 null이면 자동으로 되돌림
export function adjustEstimate(estimate: Estimate, kind: RingKind, to: Date | null): Estimate {
  const alarms = to ? moveAlarm(estimate.appointment.alarms, kind, to) : resetAlarm(estimate.appointment.alarms, kind);
  return { ...estimate, appointment: { ...estimate.appointment, alarms } };
}

// H03 초안 비교 — 직접 고른 시각은 종류별로 같은 시각인지까지 봄
const sameTimes = (x: AlarmEdits['times'], y: AlarmEdits['times']) =>
  (['WAKE', 'PREPARE', 'DEPARTURE'] as const).every((kind) => x[kind]?.getTime() === y[kind]?.getTime());

// 알람 시각을 밀어 움직이는 입력(여유 · 출발 위치 · 이동 수단 · 이동 · 준비)이 다른지 — 직접 고른 알람 시각은 뺌
// 이 입력이 바뀌어 알람이 5분 이상 움직이면 저장 전에 한 번 더 물음 (직접 고른 시각은 사용자가 이미 정한 값이라 묻지 않음)
export function timeInputsChanged(x: AlarmEdits, y: AlarmEdits) {
  return (
    x.bufferMinutes !== y.bufferMinutes ||
    x.origin !== y.origin ||
    x.transport !== y.transport ||
    x.travelMinutes !== y.travelMinutes ||
    x.prepareMinutes !== y.prepareMinutes
  );
}

export function sameEdits(x: AlarmEdits, y: AlarmEdits) {
  return !timeInputsChanged(x, y) && sameTimes(x.times, y.times);
}
