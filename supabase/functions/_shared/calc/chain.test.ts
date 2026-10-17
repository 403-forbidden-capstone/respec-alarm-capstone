// 알람 역산 — 앱 목업 계산(mobile/src/mocks/calc.ts)과 같은 숫자인지 확인하는 교차 검증
// 목업 시나리오: 2025년 5월 22일(목) 한국 시각, 10시 팀 주간회의 (mocks/data.ts a1 ~ a4)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alarmChain, departureAt, manualTimes } from './chain.ts';
import type { ChainInput, RingKind } from './types.ts';

// 2025년 5월 day일 한국 시각 minutes분 (mocks/data.ts kst와 같음)
const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
const hm = (d: Date) => {
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const text = (list: ReturnType<typeof alarmChain>) => list.map((x) => `${x.kind} ${hm(x.at)}${x.auto ? '*' : ''}`);

// mocks/data.ts 일정 (travelMinutes · bufferMinutes · beforePrepMinutes · predictedPrepMinutes · withWake)
const A1: ChainInput = { at: kst(22, 600), travelMinutes: 50, bufferMinutes: 10, beforePrepareMinutes: 30, prepareMinutes: 60, withWake: true };
const A2: ChainInput = { at: kst(22, 1080), travelMinutes: 20, bufferMinutes: 5, beforePrepareMinutes: 0, prepareMinutes: 25, withWake: false };
const A3: ChainInput = { at: kst(23, 540), travelMinutes: 50, bufferMinutes: 10, beforePrepareMinutes: 10, prepareMinutes: 40, withWake: true };

test('목업 a1 10시 팀 주간회의: 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50', () => {
  assert.deepEqual(text(alarmChain(A1)), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('목업 a2 그날 첫 일정이 아니면 기상 없이 준비부터: 준비 17:10 · 출발 17:35 · 도착 목표 17:55', () => {
  assert.deepEqual(text(alarmChain(A2)), ['PREPARE 17:10', 'DEPARTURE 17:35', 'ARRIVE 17:55']);
});

test('목업 a3 다음 날 9시 수업: 기상 7:20 · 준비 7:30 · 출발 8:00 · 도착 목표 8:50', () => {
  assert.deepEqual(text(alarmChain(A3)), ['WAKE 07:20', 'PREPARE 07:30', 'DEPARTURE 08:00', 'ARRIVE 08:50']);
});

test('준비 전 활동이 0이면 기상 알람 뒤 준비 알람이 없음', () => {
  assert.deepEqual(text(alarmChain({ ...A1, beforePrepareMinutes: 0 })), ['WAKE 08:00', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('고른 종류만 — 도착 목표는 울리는 알람이 하나라도 있을 때만', () => {
  assert.deepEqual(text(alarmChain({ ...A1, kinds: ['WAKE'] })), ['WAKE 08:00', 'ARRIVE 09:50']);
  assert.deepEqual(text(alarmChain({ ...A1, kinds: ['DEPARTURE', 'PREPARE'] })), ['PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(alarmChain({ ...A1, kinds: [] }), []); // 알람 없는 일정 (목업 a4 치과 예약)
});

test('기상 알람이 없는 일정에서 기상만 고르면 알람 없음 (그날 첫 일정이 아님)', () => {
  assert.deepEqual(text(alarmChain({ ...A2, kinds: ['WAKE'] })), []);
});

test('직접 고른 시각이 자동 계산보다 먼저, 자동값은 auto로 남김 (D42 C)', () => {
  const chain = alarmChain({ ...A1, manualTimes: { WAKE: kst(22, 450) } });
  assert.deepEqual(text(chain), ['WAKE 07:30*', 'PREPARE 08:00', 'DEPARTURE 09:00', 'ARRIVE 09:50']); // 준비는 직접 고른 기상 뒤 30분
  assert.equal(hm(chain[0].auto as Date), '08:00');
  assert.equal(chain[1].auto, undefined); // 따라온 준비는 직접 고른 것이 아님
  assert.deepEqual(manualTimes(chain), { WAKE: kst(22, 450) });
});

test('자동값과 같은 시각을 고르면 직접 고른 것이 아님', () => {
  const chain = alarmChain({ ...A1, manualTimes: { WAKE: kst(22, 480), DEPARTURE: kst(22, 540) } });
  assert.deepEqual(text(chain), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
  assert.deepEqual(manualTimes(chain), {});
});

test('도착 목표는 직접 고를 수 없음', () => {
  const times = { ARRIVE: kst(22, 580) } as unknown as Partial<Record<RingKind, Date>>;
  assert.deepEqual(text(alarmChain({ ...A1, manualTimes: times })), ['WAKE 08:00', 'PREPARE 08:30', 'DEPARTURE 09:00', 'ARRIVE 09:50']);
});

test('이동 · 여유를 바꾸면 그대로 따라 움직임', () => {
  assert.deepEqual(text(alarmChain({ ...A1, travelMinutes: 70 })), ['WAKE 07:40', 'PREPARE 08:10', 'DEPARTURE 08:40', 'ARRIVE 09:50']);
  assert.deepEqual(text(alarmChain({ ...A1, bufferMinutes: 20 })), ['WAKE 07:50', 'PREPARE 08:20', 'DEPARTURE 08:50', 'ARRIVE 09:40']);
});

test('출발 시각은 출발 알람을 안 만들어도 구할 수 있음 (단축 준비 안내 departAt)', () => {
  assert.equal(hm(departureAt({ ...A1, kinds: ['WAKE'] })), '09:00');
  assert.equal(hm(departureAt({ ...A1, kinds: [], manualTimes: { DEPARTURE: kst(22, 550) } })), '09:10');
});
