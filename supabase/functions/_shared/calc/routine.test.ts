// 루틴 제안 (안건 D114) — 하루 원인 판정 · 판정 순서 · 7번 중 4번 문턱 · 건너뛸 원인 · 원인별 초안
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectRoutineCause, morningCause, routineDraft, suggestRoutine, type MorningFacts } from './routine.ts';

// 2026-11-02(월)부터 평일 아침 i번째 — 기상 7:00 · 준비 7:20 알람, 기본은 문제없는 아침(7:03 확인 · 7:21 준비 시작)
const WEEKDAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
const at = (date: string, h: number, m: number) => Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
const morning = (i: number, over: Partial<MorningFacts> = {}): MorningFacts => {
  const date = WEEKDAYS[i];
  return {
    date,
    weekday: new Date(`${date}T12:00:00+09:00`).getUTCDay(),
    wakeAlarmAt: at(date, 7, 0),
    wakeConfirmedAt: at(date, 7, 3),
    wakeMissed: false,
    prepareAlarmAt: at(date, 7, 20),
    prepareStartedAt: at(date, 7, 21),
    itemsDue: 0,
    itemsLate: 0,
    ...over,
  };
};
const late = (i: number, min: number) => morning(i, { wakeConfirmedAt: at(WEEKDAYS[i], 7, min) });

test('하루 판정 — 늦잠은 기상 알람 + 10분을 넘거나 미확인, 준비 늦게 시작은 5분 이상, 전날 준비는 아침에야 챙긴 준비물', () => {
  assert.equal(morningCause(morning(0)), null);
  assert.equal(morningCause(late(0, 10)), null); // 딱 10분은 늦잠 아님
  assert.equal(morningCause(late(0, 11)), 'OVERSLEEP');
  assert.equal(morningCause(morning(0, { wakeMissed: true, wakeConfirmedAt: null })), 'OVERSLEEP');
  assert.equal(morningCause(morning(0, { prepareStartedAt: at(WEEKDAYS[0], 7, 24) })), null);
  assert.equal(morningCause(morning(0, { prepareStartedAt: at(WEEKDAYS[0], 7, 25) })), 'LATE_START');
  assert.equal(morningCause(morning(0, { itemsDue: 2, itemsLate: 1 })), 'NIGHT_PREP');
  assert.equal(morningCause(morning(0, { wakeAlarmAt: null })), null); // 기상 알람이 없는 날은 기록 없음
});

test('하루에 원인이 겹치면 늦잠 → 준비 늦게 시작 → 전날 준비 순서로 하나만', () => {
  const both = morning(0, { wakeConfirmedAt: at(WEEKDAYS[0], 7, 18), prepareStartedAt: at(WEEKDAYS[0], 7, 30), itemsDue: 1, itemsLate: 1 });
  assert.equal(morningCause(both), 'OVERSLEEP');
  assert.equal(morningCause({ ...both, wakeConfirmedAt: at(WEEKDAYS[0], 7, 3) }), 'LATE_START');
});

test('문턱 — 기록이 있는 최근 아침 7번 중 같은 원인 4번 이상, 7번이 안 되면 판단하지 않음', () => {
  const three = [late(0, 22), morning(1), late(2, 15), morning(3), late(4, 18), morning(5), morning(6)];
  assert.equal(detectRoutineCause(three), null);
  const four = [...three.slice(0, 6), late(6, 16)];
  const d = detectRoutineCause(four);
  assert.equal(d?.cause, 'OVERSLEEP');
  assert.deepEqual(d?.days.map((f) => f.date), ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-10']);
  assert.equal(detectRoutineCause(four.slice(1)), null); // 6번뿐
  // 알람이 없던 날은 창에 안 들어감 — 사이에 껴도 최근 기록 7번으로 봄
  assert.equal(detectRoutineCause([...four.slice(0, 3), morning(3, { wakeAlarmAt: null }), ...four.slice(3)])?.cause, 'OVERSLEEP');
});

test('최근 7번만 봄 — 오래전 늦잠은 창 밖으로 빠짐', () => {
  const old = [late(0, 20), late(1, 20), late(2, 20), late(3, 20), morning(4), morning(5), morning(6), morning(7), morning(8), morning(9)];
  assert.equal(detectRoutineCause(old), null); // 최근 7번(3 ~ 9) 중 늦잠 1번
});

test('여러 원인이 문턱을 넘으면 앞의 것 하나, 건너뛸 원인(루틴 켜져 있음 · 대기 · 넘김)은 다음 원인으로', () => {
  const ws = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 4 ? late(i, 20) : morning(i, { itemsDue: 1, itemsLate: 1 })));
  const mixed = ws.map((f, i) => (i < 4 ? { ...f } : f));
  assert.equal(detectRoutineCause(mixed)?.cause, 'OVERSLEEP');
  const night = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 3 ? late(i, 20) : morning(i, { itemsDue: 1, itemsLate: 1 })));
  assert.equal(detectRoutineCause(night)?.cause, 'NIGHT_PREP'); // 늦잠 3번은 문턱 못 넘음, 전날 준비 4번
  assert.equal(detectRoutineCause(mixed, { skip: ['OVERSLEEP'] }), null); // 전날 준비는 3번
});

test('늦잠 초안 — 그 요일에 일어나자마자 2단계, 근거는 늦은 분 평균 (미확인은 평균에서 빼고 따로 셈)', () => {
  const ms = [late(0, 22), morning(1), late(2, 15), morning(3, { wakeMissed: true, wakeConfirmedAt: null }), morning(4), late(5, 17), morning(6)];
  const r = suggestRoutine(ms);
  assert.ok(r);
  assert.equal(r.title, '일어나자마자 2단계');
  assert.deepEqual(r.days, [1, 3, 4]); // 월 · 수 · 목 (11/9 월요일 포함)
  assert.deepEqual(r.steps.map((s) => [s.name, s.offsetFromWake, s.alarm]), [['물 한 잔', 0, false], ['창문 열고 불 켜기', 3, true]]);
  assert.equal(r.reason, '최근 아침 7번 중 4번, 기상 알람 뒤 평균 18분 만에 일어났어요 (확인이 안 된 날 1번 포함)');
  assert.deepEqual(r.evidence, { dates: ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-09'], average: 18, missed: 1 });
});

test('준비 늦게 시작 초안 — 첫 단계는 준비 알람과 같은 때(기상 기준 분), 근거는 늦게 시작한 분 평균', () => {
  const ms = [0, 1, 2, 3, 4, 5, 6].map((i) => (i % 2 === 0 ? morning(i, { prepareStartedAt: at(WEEKDAYS[i], 7, 29) }) : morning(i)));
  const r = suggestRoutine(ms);
  assert.equal(r?.title, '준비 바로 시작');
  assert.deepEqual(r?.steps.map((s) => [s.name, s.offsetFromWake]), [['세수', 20], ['옷 입기', 30]]);
  assert.equal(r?.reason, '최근 아침 7번 중 4번, 준비 알람이 울리고 평균 9분 뒤에 시작했어요');
});

test('전날 준비 초안 — 문제가 난 아침의 전날 밤 요일, 시각은 고정(21:30)', () => {
  const ms = [0, 1, 2, 3, 4, 5, 6].map((i) => ([0, 2, 4, 5].includes(i) ? morning(i, { itemsDue: 2, itemsLate: 1 }) : morning(i)));
  const r = suggestRoutine(ms);
  assert.equal(r?.title, '전날 밤 준비');
  assert.deepEqual(r?.days, [0, 2, 4]); // 월 · 수 · 금 · 월 아침 → 일 · 화 · 목 밤
  assert.deepEqual(r?.steps.map((s) => [s.name, s.at, s.offsetFromWake]), [['준비물 챙기기', '21:30', null], ['옷 꺼내 두기', '21:40', null]]);
  assert.equal(r?.reason, '최근 아침 7번 중 4번, 준비물을 아침에야 챙겼어요');
});

test('설계 문서 예시 — 지민: 이번 주 3번이면 아직, 다음 주 월요일에도 늦잠이면 제안 (월 · 수 · 목)', () => {
  const week = [late(0, 22), morning(1, { wakeConfirmedAt: at(WEEKDAYS[1], 7, 4) }), late(2, 15), morning(3, { wakeMissed: true, wakeConfirmedAt: null }), morning(4, { wakeConfirmedAt: at(WEEKDAYS[4], 7, 5) })];
  const before = [morning(9), morning(8), ...week]; // 지난주 기록 2번 더해 7번
  assert.equal(suggestRoutine(before), null);
  const r = suggestRoutine([...before, late(5, 19)]);
  assert.deepEqual(r?.days, [1, 3, 4]);
  assert.equal(r?.title, '일어나자마자 2단계');
});
