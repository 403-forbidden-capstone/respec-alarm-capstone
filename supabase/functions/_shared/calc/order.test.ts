// 알람 시각 직접 고르기 · 순서 확인 — 앱 features/alarm/__tests__/adjust.test.ts와 같은 케이스
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { manualTimes } from './chain.ts';
import { autoTime, isManualTime, moveAlarm, orderError, resetAlarm } from './order.ts';
import type { AlarmKind, ChainAlarm } from './types.ts';

const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const at = (minutes: number) => kst(22, minutes);
const alarm = (kind: AlarmKind, minutes: number): ChainAlarm => ({ kind, at: at(minutes) });
// 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50
const chain = () => [alarm('WAKE', 480), alarm('PREPARE', 510), alarm('DEPARTURE', 540), alarm('ARRIVE', 590)];
const hm = (d: Date) => {
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const times = (alarms: ChainAlarm[]) => alarms.map((x) => `${x.kind} ${hm(x.at)}${isManualTime(x) ? '*' : ''}`);

test('기상을 앞당기면 준비도 같은 만큼, 출발 · 도착 목표는 그대로. 직접 고른 기상에만 표시', () => {
  const moved = moveAlarm(chain(), 'WAKE', at(450));
  assert.deepEqual(times(moved), ['WAKE 07:30*', 'PREPARE 08:00', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(autoTime(moved[0]), at(480)); // 자동 계산값은 그대로 남김
});

test('기상을 늦춰도 같은 간격', () => {
  assert.deepEqual(times(moveAlarm(chain(), 'WAKE', at(495))), ['WAKE 08:15*', 'PREPARE 08:45', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('준비 · 출발은 그 알람만 옮김', () => {
  assert.deepEqual(times(moveAlarm(chain(), 'PREPARE', at(520))), ['WAKE 08:00', 'PREPARE 08:40*', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(times(moveAlarm(chain(), 'DEPARTURE', at(530))), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 08:50*', 'ARRIVE 09:50']);
});

test('자동 계산값과 같은 시각으로 옮기면 직접 고른 것이 아님', () => {
  const once = moveAlarm(chain(), 'PREPARE', at(520));
  assert.deepEqual(times(moveAlarm(once, 'PREPARE', at(510))), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('직접 고른 준비가 있으면 기상을 옮길 때 같이 옮기고, 자동값과의 차이는 그대로', () => {
  const prepared = moveAlarm(chain(), 'PREPARE', at(520));
  const moved = moveAlarm(prepared, 'WAKE', at(450));
  assert.deepEqual(times(moved), ['WAKE 07:30*', 'PREPARE 08:10*', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(autoTime(moved[1]), at(480));
});

test('여러 번 나눠 옮겨도 합친 간격만큼', () => {
  let alarms = chain();
  for (const minute of [481, 482, 483, 470, 450]) alarms = moveAlarm(alarms, 'WAKE', at(minute));
  assert.deepEqual(times(alarms), ['WAKE 07:30*', 'PREPARE 08:00', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('자동으로 되돌리면 기상과 따라온 준비가 함께 원래대로', () => {
  const moved = moveAlarm(chain(), 'WAKE', at(450));
  assert.deepEqual(times(resetAlarm(moved, 'WAKE')), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(resetAlarm(chain(), 'WAKE'), chain());
});

test('없는 종류를 옮기려 하면 그대로', () => {
  const noWake = chain().filter((x) => x.kind !== 'WAKE');
  assert.deepEqual(moveAlarm(noWake, 'WAKE', at(450)), noWake);
});

test('직접 고른 시각만 모음 — 따라온 준비는 자동이라 빠짐', () => {
  assert.deepEqual(manualTimes(moveAlarm(chain(), 'WAKE', at(450))), { WAKE: at(450) });
  assert.deepEqual(manualTimes(moveAlarm(moveAlarm(chain(), 'WAKE', at(450)), 'PREPARE', at(490))), { WAKE: at(450), PREPARE: at(490) });
  assert.deepEqual(manualTimes(chain()), {});
});

test('순서 확인: 맞으면 null, 같은 시각은 허용, 만든 알람만 비교', () => {
  assert.equal(orderError(chain()), null);
  assert.equal(orderError(moveAlarm(chain(), 'PREPARE', at(540))), null); // 준비 = 출발
  assert.equal(orderError([alarm('PREPARE', 510), alarm('DEPARTURE', 540), alarm('ARRIVE', 590)]), null); // 기상 알람 없는 일정
  assert.equal(orderError([]), null); // 알람 없는 일정
});

test('기상을 크게 늦추면 따라온 준비가 출발을 넘어 순서가 뒤집힘', () => {
  const err = orderError(moveAlarm(chain(), 'WAKE', at(600))); // 기상 10:00 · 준비 10:30 · 출발 9:00
  assert.equal(err?.message, '출발 시각이 준비보다 빠를 수 없어요');
  assert.deepEqual([err?.earlier, err?.later], ['PREPARE', 'DEPARTURE']);
});

test('뒤집히면 어느 둘이 어긋났는지', () => {
  assert.equal(orderError(moveAlarm(chain(), 'PREPARE', at(470)))?.message, '준비 시각이 기상보다 빠를 수 없어요');
  assert.equal(orderError(moveAlarm(chain(), 'DEPARTURE', at(600)))?.message, '출발 시각이 도착 목표보다 늦을 수 없어요');
});
