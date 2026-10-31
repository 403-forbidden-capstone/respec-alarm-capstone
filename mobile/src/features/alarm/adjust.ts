// 알람 시각을 직접 고르기 (H03 · H05 확인 시트, D42 C · D43) — 순수 계산만, 단위 테스트는 __tests__/adjust.test.ts
// 규칙은 서버 함수와 같은 공용 계산(supabase/functions/_shared/calc/order.ts)을 씀 (전체작업계획 8.1 Q4 A) — 여기는 AlarmTime(id · enabled가 붙음) ↔ 공용 모양만 바꿈
// 규칙 (전체작업계획 8.1 F5 해석):
//   · 직접 고른 시각은 "직접 고름"으로 표시하고 자동 계산보다 먼저 씀 (강도 직접 고르기와 같은 규칙). 자동 계산값과 같아지면 다시 자동
//   · 기상을 옮기면 준비도 같은 간격으로 따라옴. 출발 · 도착 목표는 약속에 묶여 그대로
//   · 순서(기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)가 뒤집히면 저장을 막음
import { formatTime } from '@/lib/format';
import {
  autoTime as sharedAutoTime,
  isManualTime as sharedIsManualTime,
  moveAlarm as sharedMoveAlarm,
  orderError as sharedOrderError,
  resetAlarm as sharedResetAlarm,
} from '@shared/calc/order.ts';
import { manualTimes as sharedManualTimes } from '@shared/calc/chain.ts';
import type { ChainAlarm } from '@shared/calc/types.ts';

import { KIND_LABEL, type AlarmEdits, type AlarmPreview, type AlarmTime, type Estimate, type RingKind } from './types';

// 자동으로 계산했다면 이 시각 — 직접 고르지 않았으면 지금 시각
export const autoTime = (x: AlarmTime): Date => sharedAutoTime(x);

// 직접 고른 시각인지
export const isManualTime = (x: AlarmTime): boolean => sharedIsManualTime(x);

const toChain = (alarms: readonly AlarmTime[]): ChainAlarm[] => alarms.map((x) => (x.auto ? { kind: x.kind, at: x.at, auto: x.auto } : { kind: x.kind, at: x.at }));

// 공용 계산 결과(kind · at · auto)에 원래 알람의 id · enabled를 다시 붙임 — 공용 계산은 순서와 종류를 바꾸지 않음
function fromChain(chain: readonly ChainAlarm[], base: readonly AlarmTime[]): AlarmTime[] {
  return chain.map((c, i) => {
    const next: AlarmTime = { ...base[i], at: c.at };
    if (c.auto) next.auto = c.auto;
    else delete next.auto;
    return next;
  });
}

// kind 알람을 to로 옮김. 기상이면 준비 알람도 같은 간격만큼 같이 옮김
export function moveAlarm(alarms: AlarmTime[], kind: RingKind, to: Date): AlarmTime[] {
  if (!alarms.some((x) => x.kind === kind)) return alarms; // 없는 종류는 그대로 (같은 배열 — 화면 상태가 불필요하게 안 바뀜)
  return fromChain(sharedMoveAlarm(toChain(alarms), kind, to), alarms);
}

// 직접 고른 시각을 자동 계산값으로 되돌림 (기상이면 따라온 준비도 함께 되돌아감)
export function resetAlarm(alarms: AlarmTime[], kind: RingKind): AlarmTime[] {
  if (!alarms.some((x) => x.kind === kind)) return alarms;
  return fromChain(sharedResetAlarm(toChain(alarms), kind), alarms);
}

// 직접 고른 시각만 모음 (H03 초안 · 저장할 값) — 없는 종류는 자동
export function manualTimes(alarms: AlarmTime[]): Partial<Record<RingKind, Date>> {
  return sharedManualTimes(toChain(alarms));
}

// 순서가 뒤집혔으면 사용자에게 보일 짧은 이유, 맞으면 null — 저장을 막을 때 씀
// 기상 ≤ 준비 ≤ 출발 ≤ 도착 목표 (같은 시각은 허용). 목록에 있는 알람끼리 비교 — 만들지 않은 종류(H05에서 안 켠 것)는 빠지고,
//   H03에서 꺼 둔 알람은 다시 켤 수 있어서 시각이 있는 한 같이 비교함 (그래서 꺼 둔 알람의 순서 때문에 저장이 막힐 수 있음)
// 어느 둘이 어긋났는지는 공용 계산이 정하고, 도착 목표 문구에만 앱이 시각을 덧붙임 (서버 문구는 시각 없음)
export function orderError(alarms: AlarmTime[]): string | null {
  const error = sharedOrderError(toChain(alarms));
  if (!error) return null;
  if (error.later === 'ARRIVE') {
    const arrive = alarms.find((x) => x.kind === 'ARRIVE');
    return `${KIND_LABEL[error.earlier]} 시각이 도착 목표(${arrive ? formatTime(arrive.at) : ''})보다 늦을 수 없어요`;
  }
  return `${KIND_LABEL[error.later]} 시각이 ${KIND_LABEL[error.earlier]}보다 빠를 수 없어요`;
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

// H03에 보일 알람 — 입력을 안 바꿨으면 저장된 값. 열자마자 다시 계산한 값(길찾기 · 기록이 그새 달라짐)으로 바꾸면 저장된 7:20이 7:37로 보임
// 다시 계산해야 아는 것(기록 기반 준비 줄 · 길찾기 안내)만 다시 계산한 값에서 가져옴
export function shownPreview(edits: AlarmEdits, savedEdits: AlarmEdits, saved: AlarmPreview, recalculated: AlarmPreview): AlarmPreview {
  return sameEdits(edits, savedEdits) ? { ...recalculated, ...saved } : recalculated;
}
