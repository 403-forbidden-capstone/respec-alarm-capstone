// 저장 검증 — 8장 8.2.1 · 7장 7.1.4
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alarmChain, departureAt } from './chain.ts';
import { moveAlarm } from './order.ts';
import type { ChainInput } from './types.ts';
import { PAST_GRACE_MINUTES, checkAlarms } from './validate.ts';

const kst = (day: number, minutes: number) => new Date(Date.UTC(2025, 4, day) + (minutes - 9 * 60) * 60_000);
// 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50
const A1: ChainInput = { at: kst(22, 600), travelMinutes: 50, bufferMinutes: 10, beforePrepareMinutes: 30, prepareMinutes: 60, withWake: true };
const run = (input: ChainInput, now: Date) => checkAlarms(alarmChain(input), departureAt(input), now);

test('여유 있게 앞이면 전부 켜서 저장', () => {
  const r = run(A1, kst(22, 420));
  assert.ok(r.ok);
  assert.deepEqual(r.alarms.map((x) => x.enabled), [true, true, true, true]);
});

test('기상이 지금 + 5분보다 앞이면 기상만 끄고 나머지는 저장 (8.2.1)', () => {
  const r = run(A1, kst(22, 478)); // 기상 8:00 < 7:58 + 5분
  assert.ok(r.ok);
  assert.deepEqual(r.alarms.map((x) => `${x.kind}:${x.enabled}`), ['WAKE:false', 'PREPARE:true', 'DEPARTURE:true', 'ARRIVE:true']);
  assert.equal(r.alarms[0].disabledReason, 'PASSED');
});

test('정확히 지금 + 5분이면 아직 켬 (앞일 때만 끔)', () => {
  const r = run(A1, kst(22, 480 - PAST_GRACE_MINUTES));
  assert.ok(r.ok);
  assert.equal(r.alarms[0].enabled, true);
});

test('기상 · 준비가 지났어도 출발 전이면 저장 (출발 · 도착 목표는 켬)', () => {
  const r = run(A1, kst(22, 535));
  assert.ok(r.ok);
  assert.deepEqual(r.alarms.map((x) => `${x.kind}:${x.enabled}`), ['WAKE:false', 'PREPARE:false', 'DEPARTURE:true', 'ARRIVE:true']);
});

test('출발 시각까지 지났으면 저장 막음 (UNPROCESSABLE)', () => {
  const r = run(A1, kst(22, 541));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'DEPARTURE_PASSED');
});

test('출발 알람을 안 만들어도 출발 시각이 지났으면 막음', () => {
  const input: ChainInput = { ...A1, kinds: ['WAKE'] };
  const r = checkAlarms(alarmChain(input), departureAt(input), kst(22, 541));
  assert.equal(!r.ok && r.reason, 'DEPARTURE_PASSED');
});

test('알람을 하나도 안 만든 일정은 시각 검사를 하지 않음', () => {
  const r = checkAlarms(alarmChain({ ...A1, kinds: [] }), departureAt(A1), kst(22, 700));
  assert.deepEqual(r, { ok: true, alarms: [] });
});

test('순서가 뒤집히면 막음 — 기상을 출발보다 늦게 고름', () => {
  const moved = moveAlarm(alarmChain(A1), 'WAKE', kst(22, 600));
  const r = checkAlarms(moved, kst(22, 540), kst(22, 420));
  assert.equal(!r.ok && r.reason, 'ORDER');
  assert.equal(!r.ok && r.message, '출발 시각이 준비보다 빠를 수 없어요');
});

test('직접 고른 기상이 과거면 그 알람만 끔', () => {
  const r = run({ ...A1, manualTimes: { WAKE: kst(22, 400) } }, kst(22, 420));
  assert.ok(r.ok);
  assert.equal(r.alarms[0].enabled, false);
  assert.equal(r.alarms[1].enabled, true);
});
