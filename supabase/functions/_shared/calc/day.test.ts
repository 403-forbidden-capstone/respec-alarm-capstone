// 하루 활동 계산 — 기상 → 할 일 → 준비 → 출발 (calc/day.ts)
//   기준 예: 내일 10~11시 집에서 온라인 회의, 13시 학교 수업. 회의 전 20분 · 외출 준비 30분 · 이동 40분 · 여유 10분
//   → 기상 09:40 · 준비 11:40 · 출발 12:10 · 도착 목표 12:50
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alarmChain } from './chain.ts';
import { dayFailureMessage, planDay, type DayInput } from './day.ts';

// 2026년 11월 day일 한국 시각 h:m
const kst = (h: number, m = 0, day = 19) => new Date(Date.UTC(2026, 10, day, h - 9, m));
const hm = (d: Date) => d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// 적용 준비(기상~출발) 50 = 준비 전 20 + 외출 준비 30
const base = (over: Partial<DayInput> = {}): DayInput => ({ at: kst(13), travelMinutes: 40, bufferMinutes: 10, prepareMinutes: 50, beforePrepareMinutes: 20, activities: [], ...over });
const meeting = { title: '온라인 회의', start: kst(10), end: kst(11), beforePrepare: true };
// planDay 결과를 기존 역산에 넣어 실제 알람 시각으로
const chainOf = (input: DayInput) => {
  const day = planDay(input);
  assert.ok(day.ok, JSON.stringify(day));
  return alarmChain({ at: input.at, travelMinutes: input.travelMinutes, bufferMinutes: input.bufferMinutes, prepareMinutes: day.prepareMinutes, beforePrepareMinutes: day.beforePrepareMinutes, withWake: true }).map((x) => `${x.kind} ${hm(x.at)}`);
};

test('1. 할 일 없음: 기존 역산과 같은 시각 (기상 = 출발 − 준비)', () => {
  const day = planDay(base());
  assert.ok(day.ok);
  assert.deepEqual([day.prepareMinutes, day.beforePrepareMinutes], [50, 20]);
  assert.deepEqual(chainOf(base()), ['WAKE 19일 11:20', 'PREPARE 19일 11:40', 'DEPARTURE 19일 12:10', 'ARRIVE 19일 12:50']);
});

test('2. 기상 → 온라인 회의 → 준비 → 출발: 기상은 회의에, 준비 · 출발은 수업에 맞춤', () => {
  assert.deepEqual(chainOf(base({ activities: [meeting] })), ['WAKE 19일 09:40', 'PREPARE 19일 11:40', 'DEPARTURE 19일 12:10', 'ARRIVE 19일 12:50']);
  const day = planDay(base({ activities: [meeting] }));
  assert.ok(day.ok);
  assert.deepEqual([day.prepareMinutes, day.beforePrepareMinutes], [150, 120]); // 기상~출발 150 = 20 + 회의 60 + 빈 40 + 준비 30
});

test('3. 회의 전에 외출 준비를 마침: 준비는 회의 시작까지, 출발은 그대로', () => {
  const after = { ...meeting, start: kst(11), end: kst(12), beforePrepare: false };
  assert.deepEqual(chainOf(base({ activities: [after] })), ['WAKE 19일 10:10', 'PREPARE 19일 10:30', 'DEPARTURE 19일 12:10', 'ARRIVE 19일 12:50']);
});

test('3b. 준비 뒤 할 일이 출발보다 늦게 끝나면 실패', () => {
  const day = planDay(base({ activities: [{ ...meeting, start: kst(11, 30), end: kst(12, 30), beforePrepare: false }] }));
  assert.deepEqual(day, { ok: false, reason: 'AFTER_DEPARTURE', index: 0, shortMinutes: 20 });
});

test('4. 회의가 늦게 끝나 준비할 시간이 모자라면 기상을 당기지 않고 실패 + 모자란 분', () => {
  const late = { ...meeting, start: kst(11), end: kst(11, 55) };
  const day = planDay(base({ activities: [late] }));
  assert.deepEqual(day, { ok: false, reason: 'NO_TIME_TO_PREPARE', index: 0, shortMinutes: 15 });
  assert.equal(dayFailureMessage(day as Exclude<typeof day, { ok: true }>), '할 일이 끝나고 준비할 시간이 15분 모자라요');
});

test('5. 기상과 준비 사이에 할 일 여럿: 기상은 가장 이른 할 일에, 준비는 마지막 할 일 뒤', () => {
  const second = { title: '과제 제출', start: kst(11, 10), end: kst(11, 30), beforePrepare: true };
  // 순서를 섞어 보내도 시각순으로
  assert.deepEqual(chainOf(base({ activities: [second, meeting] })), ['WAKE 19일 09:40', 'PREPARE 19일 11:40', 'DEPARTURE 19일 12:10', 'ARRIVE 19일 12:50']);
});

test('5b. 할 일끼리 겹치면 실패', () => {
  const overlap = { title: '과제', start: kst(10, 30), end: kst(11, 10), beforePrepare: true };
  const day = planDay(base({ activities: [meeting, overlap] }));
  assert.deepEqual(day, { ok: false, reason: 'OVERLAP', index: 1, shortMinutes: 30 });
});

test('끝 시각 · 준비 전후를 모르면 NEEDS_INFO + 빠진 칸만 (말한 칸은 다시 안 물음)', () => {
  const day = planDay(base({ activities: [{ title: '회의', start: kst(10), beforePrepare: true }, { title: '통화', start: kst(11), end: kst(11, 10) }] }));
  assert.deepEqual(day, { ok: false, reason: 'NEEDS_INFO', missing: [{ index: 0, field: 'end' }, { index: 1, field: 'before_prepare' }] });
});

test('8. 날짜가 바뀌는 일정: 01:00 약속 · 전날 밤 회의 → 기상이 전날 밤', () => {
  const at = kst(1, 0, 20);
  const night = { title: '야간 회의', start: kst(22, 0, 19), end: kst(23, 0, 19), beforePrepare: true };
  assert.deepEqual(chainOf(base({ at, activities: [night] })), ['WAKE 19일 21:40', 'PREPARE 19일 23:40', 'DEPARTURE 20일 00:10', 'ARRIVE 20일 00:50']);
});

test('준비 전 시간이 기상~출발보다 크게 들어와도 외출 준비를 음수로 만들지 않음', () => {
  const day = planDay(base({ prepareMinutes: 15, beforePrepareMinutes: 20, activities: [meeting] }));
  assert.ok(day.ok);
  assert.equal(hm(day.prepare), '19일 12:10'); // 외출 준비 0분 → 준비 = 출발
});
