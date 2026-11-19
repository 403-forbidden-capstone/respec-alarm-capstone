// 루틴 제안 만들기 (안건 D114) — 재료 → 제안, 건너뛰기(기다림 · 켜진 루틴 · 넘긴 뒤 3번), 넣기(겹친 기다림은 건너뜀)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDb } from './fake-db.ts';
import { planRoutineSuggestions, runRoutineSuggest, skipFor, toMorning, type ExistingRoutineSuggestion, type RoutineInputRow } from './routine-run.ts';
import type { Db } from './supabase.ts';

// 12/14(월)부터 평일 — 기상 7:00 · 준비 7:20
const DATES = ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25'];
const t = (date: string, h: number, m: number) => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`).toISOString();
const row = (user: string, i: number, over: Partial<RoutineInputRow> = {}): RoutineInputRow => ({
  user_id: user,
  record_date: DATES[i],
  weekday: new Date(`${DATES[i]}T12:00:00+09:00`).getUTCDay(),
  wake_alarm_at: t(DATES[i], 7, 0),
  wake_confirmed_at: t(DATES[i], 7, 3),
  wake_missed: false,
  prepare_alarm_at: t(DATES[i], 7, 20),
  prepare_started_at: t(DATES[i], 7, 21),
  items_due: 0,
  items_late: 0,
  ...over,
});
const late = (user: string, i: number) => row(user, i, { wake_confirmed_at: t(DATES[i], 7, 20) });
// u1: 7번 중 4번 늦잠 (월 · 수 · 금 · 월), u2: 문제없음
const rows = [...[0, 1, 2, 3, 4, 5, 6].map((i) => ([0, 2, 4, 5].includes(i) ? late('u1', i) : row('u1', i))), ...[0, 1, 2, 3, 4, 5, 6].map((i) => row('u2', i))];

test('재료 한 줄 → 규칙의 아침 (시각은 ms, 숫자 칸 비면 0)', () => {
  const m = toMorning(row('u1', 0, { items_due: null as unknown as number }));
  assert.equal(m.wakeAlarmAt, Date.parse(t(DATES[0], 7, 0)));
  assert.equal(m.itemsDue, 0);
});

test('7번 중 4번 늦잠인 사람만 제안 — 이름 · 근거 · 초안(요일 월 · 수 · 금)이 규칙 그대로', () => {
  const plan = planRoutineSuggestions([...rows].reverse(), []); // 순서가 섞여 와도 날짜순으로 봄
  assert.equal(plan.length, 1);
  assert.equal(plan[0].user_id, 'u1');
  assert.equal(plan[0].cause, 'OVERSLEEP');
  assert.equal(plan[0].title, '일어나자마자 2단계');
  assert.equal(plan[0].reason, '최근 아침 7번 중 4번, 기상 알람 뒤 평균 20분 만에 일어났어요');
  assert.deepEqual(plan[0].draft.days, [1, 3, 5]);
  assert.equal(plan[0].draft.steps.length, 2);
});

test('건너뛰기 — 기다리는 제안이 있으면 아무것도, 받아들인 루틴이 켜져 있으면 그 원인만, 꺼졌으면 다시 후보', () => {
  const base = { user_id: 'u1', cause: 'OVERSLEEP' as const, responded_at: t(DATES[0], 20, 0) };
  assert.equal(skipFor([{ ...base, status: 'PENDING', responded_at: null, routine_active: false }], []), null);
  assert.deepEqual(skipFor([{ ...base, status: 'ACCEPTED', routine_active: true }], []), ['OVERSLEEP']);
  assert.deepEqual(skipFor([{ ...base, status: 'ACCEPTED', routine_active: false }], []), []);
  assert.deepEqual(planRoutineSuggestions(rows, [{ ...base, status: 'ACCEPTED', routine_active: true }]), []);
});

test('넘긴 원인은 넘긴 뒤 기록이 있는 아침 3번이 쌓여야 다시 후보 (D24 C)', () => {
  const mornings = rows.filter((r) => r.user_id === 'u1').map(toMorning);
  const ignored = (day: number): ExistingRoutineSuggestion => ({ user_id: 'u1', cause: 'OVERSLEEP', status: 'IGNORED', responded_at: t(DATES[day], 20, 0), routine_active: false });
  assert.deepEqual(skipFor([ignored(4)], mornings), ['OVERSLEEP']); // 넘긴 뒤 아침 2번 (12/21 · 12/22)
  assert.deepEqual(skipFor([ignored(3)], mornings), []); // 넘긴 뒤 아침 3번
});

test('runRoutineSuggest — 재료 함수를 지금 시각으로 부르고, 지난 제안 · 루틴을 읽어 넣음, 겹친 기다림(23505)은 건너뜀', async () => {
  const db = new FakeDb();
  const now = new Date(t(DATES[6], 18, 0));
  db.rpcHandlers.routine_suggestion_inputs = () => rows;
  db.tables.routine_suggestions = [];
  db.tables.routines = [];
  const original = db.from.bind(db);
  let inserts = 0;
  db.from = ((table: string) => {
    const q = original(table);
    if (table !== 'routine_suggestions') return q;
    return Object.assign(q, {
      insert: () => {
        inserts += 1;
        return Promise.resolve({ data: null, error: inserts === 1 ? null : { code: '23505', message: 'dup' } });
      },
    });
  }) as typeof db.from;
  const res = await runRoutineSuggest(db as unknown as Db, now);
  assert.deepEqual(db.rpcCalls, [{ name: 'routine_suggestion_inputs', args: { p_now: now.toISOString() } }]);
  assert.deepEqual(res, { users: 2, created: 1, skipped: 0 });
});

test('runRoutineSuggest — 재료가 없으면 아무것도 안 읽고 안 넣음', async () => {
  const db = new FakeDb();
  db.rpcHandlers.routine_suggestion_inputs = () => [];
  assert.deepEqual(await runRoutineSuggest(db as unknown as Db, new Date()), { users: 0, created: 0, skipped: 0 });
});
