// 출발 여유 — 상세설계서 7장 7.5.2 표 그대로 (약속 10:00 · 이동 50 · 여유 10 · 기상~출발 60)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEPART_COMFORT_MIN_SLACK, departNow, departSlack, departStatus } from './depart.ts';
import * as calc from './index.ts';

// 2025년 5월 22일 한국 시각 minutes분 (mocks/data.ts kst와 같음)
const kst = (minutes: number) => new Date(Date.UTC(2025, 4, 22) + (minutes - 9 * 60) * 60_000);
const hm = (d: Date) => {
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const APPOINTMENT = kst(600); // 10:00
const BASE = { appointmentAt: APPOINTMENT, travelMinutes: 50 };
const PREPARE_MINUTES = 60; // 기상 ~ 출발 (여유 10분은 이동 앞에 따로)

// 기상 직후(남은 준비 = 준비 전체)의 여유
const afterWake = (wakeMinutes: number) => departSlack({ ...BASE, now: kst(wakeMinutes), remainingMinutes: PREPARE_MINUTES });

test('7.5.2 표: 08:00 기상 → 여유 10분 · 여유', () => {
  assert.deepEqual(afterWake(480), { slackMinutes: 10, status: 'COMFORT' });
});

test('7.5.2 표: 08:05 기상 → 여유 5분 · 빠듯', () => {
  assert.deepEqual(afterWake(485), { slackMinutes: 5, status: 'TIGHT' });
});

test('7.5.2 표: 08:25 기상 → 여유 −15분 · 지각 위험', () => {
  assert.deepEqual(afterWake(505), { slackMinutes: -15, status: 'LATE_RISK' });
});

test('출발 한계는 약속 − 이동 (약속 앞 여유 10분을 빼지 않음) → 09:10에 나가면 slack 0, 빠듯', () => {
  // 알람 체인의 출발은 09:00 (여유 10분을 먼저 뺌) — slack은 그 여유만큼 남은 것으로 읽음
  assert.deepEqual(departSlack({ ...BASE, now: kst(540), remainingMinutes: 0 }), { slackMinutes: 10, status: 'COMFORT' });
  assert.deepEqual(departSlack({ ...BASE, now: kst(550), remainingMinutes: 0 }), { slackMinutes: 0, status: 'TIGHT' });
  assert.deepEqual(departSlack({ ...BASE, now: kst(551), remainingMinutes: 0 }), { slackMinutes: -1, status: 'LATE_RISK' });
});

test('경계: 10분은 여유, 9분은 빠듯, 0분은 빠듯, −1분은 지각 위험', () => {
  assert.equal(DEPART_COMFORT_MIN_SLACK, 10);
  assert.deepEqual([10, 9, 0, -1].map(departStatus), ['COMFORT', 'TIGHT', 'TIGHT', 'LATE_RISK']);
});

test('남은 준비가 줄수록 같은 시각의 여유가 늘어남 (08:25에 일어나도 준비를 35분으로 줄이면 여유 10분)', () => {
  assert.deepEqual(departSlack({ ...BASE, now: kst(505), remainingMinutes: 35 }), { slackMinutes: 10, status: 'COMFORT' });
});

test('지금 나가면: 09:00 출발 → 09:50 도착 · 여유 10분', () => {
  const r = departNow({ ...BASE, now: kst(540) });
  assert.equal(hm(r.arriveAt), '09:50');
  assert.deepEqual([r.slackMinutes, r.status], [10, 'COMFORT']);
});

test('지금 나가면: 늦게 나가면 도착이 약속 뒤 → 여유가 음수', () => {
  const r = departNow({ ...BASE, now: kst(570) }); // 09:30 출발 → 10:20 도착
  assert.equal(hm(r.arriveAt), '10:20');
  assert.deepEqual([r.slackMinutes, r.status], [-20, 'LATE_RISK']);
});

test('departNow는 남은 준비 0인 departSlack과 같은 값 (도착 = 약속 − 여유)', () => {
  for (const now of [kst(500), kst(540), kst(550), kst(560)]) {
    const a = departNow({ ...BASE, now });
    const b = departSlack({ ...BASE, now, remainingMinutes: 0 });
    assert.deepEqual([a.slackMinutes, a.status], [b.slackMinutes, b.status]);
    assert.equal(a.slackMinutes, Math.round((APPOINTMENT.getTime() - a.arriveAt.getTime()) / 60_000));
  }
});

test('분 단위는 기존 calc처럼 반올림 (초가 있는 지금도 -0이 아닌 0)', () => {
  const now = new Date(kst(550).getTime() + 20_000); // 09:10:20
  const r = departSlack({ ...BASE, now, remainingMinutes: 0 });
  assert.ok(Object.is(r.slackMinutes, 0));
  assert.equal(r.status, 'TIGHT');
});

test('calc 묶음(@shared/calc)에서도 불림', () => {
  assert.equal(calc.departSlack, departSlack);
  assert.equal(calc.departNow, departNow);
});
