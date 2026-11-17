// 알람 조정 제안 적용 — 당김 차이만큼 알람 옮기기(순수) · 적용 / 되돌리기 / 무시 / 고쳐 적용(가짜 DB)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDb } from './fake-db.ts';
import type { AlarmRow } from './plan-core.ts';
import { runSuggestApply, shiftForAdvance, type ApplyCtx } from './suggest-apply.ts';
import type { Db } from './supabase.ts';

// 5월 day일 한국 시각 h:m
const kst = (day: number, h: number, m: number) => new Date(Date.UTC(2025, 4, day, h - 9, m)).toISOString();
const hm = (iso: string) => {
  const d = new Date(iso);
  return `${String((d.getUTCHours() + 9) % 24).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const alarm = (id: string, type: AlarmRow['alarm_type'], at: string, over: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: id, participant_id: 'pt', user_id: 'u1', alarm_type: type, scheduled_at: at,
  intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, is_enabled: true, snooze_limit: 3,
  time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null, ...over,
} as AlarmRow);
// 9시 수업: 출발 8:25(이동 30 · 여유 5), 준비 시간 60 → 기상 7:25, 준비 전 활동 20 → 준비 7:45
const day = (d: number, wake: [number, number], prep: [number, number], over: Partial<AlarmRow> = {}) => [
  alarm(`w${d}`, 'WAKE', kst(d, ...wake)), alarm(`p${d}`, 'PREPARE', kst(d, ...prep), over), alarm(`d${d}`, 'DEPARTURE', kst(d, 8, 25)),
];
const moved = (list: { alarm_id: string; scheduled_at: string }[]) => list.map((x) => `${x.alarm_id} ${hm(x.scheduled_at)}`);

test('당김 0 → 10: 준비 알람만 10분 앞당김 (기상 · 출발 그대로)', () => {
  assert.deepEqual(moved(shiftForAdvance(day(23, [7, 25], [7, 45]), 0, 10, 60)), ['p23 07:35']);
});

test('당김 10 → 25: 준비 전 활동 20을 넘는 5분만큼 기상도 앞당김, 준비는 기상과 같은 시각', () => {
  assert.deepEqual(moved(shiftForAdvance(day(23, [7, 25], [7, 35]), 10, 25, 60)), ['w23 07:20', 'p23 07:20']);
});

test('되돌리기 25 → 0: 기상 · 준비가 원래 자리로', () => {
  assert.deepEqual(moved(shiftForAdvance(day(23, [7, 20], [7, 20]), 25, 0, 60)), ['w23 07:25', 'p23 07:45']);
});

test('준비 알람을 직접 고른 일정 · 차이 0은 옮기지 않음, 기상을 직접 골랐으면 기상은 그대로 두고 준비는 기상보다 앞서지 않게', () => {
  assert.deepEqual(shiftForAdvance(day(23, [7, 25], [7, 45], { time_source: 'MANUAL' }), 0, 10, 60), []);
  assert.deepEqual(shiftForAdvance(day(23, [7, 25], [7, 45]), 10, 10, 60), []);
  const manualWake = [alarm('w', 'WAKE', kst(23, 7, 40), { time_source: 'MANUAL' }), alarm('p', 'PREPARE', kst(23, 7, 45)), alarm('d', 'DEPARTURE', kst(23, 8, 25))];
  assert.deepEqual(moved(shiftForAdvance(manualWake, 0, 10, 60)), ['p 07:40']);
});

test('기상 알람이 없는 일정은 준비 알람만', () => {
  assert.deepEqual(moved(shiftForAdvance([alarm('p', 'PREPARE', kst(23, 8, 0)), alarm('d', 'DEPARTURE', kst(23, 8, 25))], 0, 10, 15)), ['p 07:50']);
});

// 묶음 S: 22일(지난 회차) · 23일(제안 대상) · 24일 · 25일(이번만 지움) — 지금 22일 20:00
const seed = (status = 'PENDING') => {
  const db = new FakeDb();
  db.tables.alarm_suggestions = [{ suggestion_id: 's1', user_id: 'u1', target_alarm_id: 'p23', suggestion_type: 'PREPARE_ADVANCE', status, current_value: '0', suggested_value: '10', result_value: null, responded_at: null }];
  db.tables.profiles = [{ user_id: 'u1', timezone: 'Asia/Seoul' }];
  db.tables.appointments = [];
  db.tables.appointment_participants = [];
  db.tables.alarms = [];
  for (const d of [22, 23, 24, 25]) {
    db.tables.appointments.push({ appointment_id: `a${d}`, series_id: 'S', appointment_at: kst(d, 9, 0), title: '수업', dest_name: '세종대학교', exception_kind: d === 25 ? 'CANCELED' : null });
    db.tables.appointment_participants.push({ participant_id: `pt${d}`, appointment_id: `a${d}`, user_id: 'u1', prepare_minutes: 60, prepare_advance_minutes: 0, est_travel_minutes: 30 });
    for (const a of day(d, [7, 25], [7, 45])) db.tables.alarms.push({ ...a, participant_id: `pt${d}` });
  }
  return db;
};
const ctxOf = (db: FakeDb): ApplyCtx => ({ db: db as unknown as Db, write: db as unknown as Db, userId: 'u1', now: new Date(kst(22, 20, 0)) });
const prepOf = (db: FakeDb, d: number) => hm(db.rows('alarms').find((a) => a.alarm_id === `p${d}`)!.scheduled_at as string);
const advOf = (db: FakeDb, d: number) => db.rows('appointment_participants').find((p) => p.participant_id === `pt${d}`)!.prepare_advance_minutes;

test('적용: 대상 회차와 이후 회차의 준비 알람을 10분 앞당기고 당김 분 10, 지난 회차 · 이번만 지운 회차는 그대로, 제안은 APPLIED', async () => {
  const db = seed();
  const res = await runSuggestApply(ctxOf(db), { suggestionId: 's1', action: 'APPLY' });
  assert.deepEqual([prepOf(db, 22), prepOf(db, 23), prepOf(db, 24), prepOf(db, 25)], ['07:45', '07:35', '07:35', '07:45']);
  assert.deepEqual([advOf(db, 22), advOf(db, 23), advOf(db, 24), advOf(db, 25)], [0, 10, 10, 0]);
  assert.equal(res.status, 'APPLIED');
  assert.equal(res.advance, 10);
  assert.deepEqual(res.ring_packages.map((p) => `${p.alarmId} ${p.type}`).sort(), ['p23 PREPARE', 'p24 PREPARE']);
  assert.deepEqual(db.rows('alarm_suggestions')[0], { ...db.rows('alarm_suggestions')[0], status: 'APPLIED', result_value: '10' });

  const back = await runSuggestApply(ctxOf(db), { suggestionId: 's1', action: 'REVERT' });
  assert.deepEqual([prepOf(db, 23), prepOf(db, 24)], ['07:45', '07:45']);
  assert.deepEqual([advOf(db, 23), advOf(db, 24)], [0, 0]);
  assert.equal(back.status, 'PENDING'); // D23 A — 대기로
  assert.equal(db.rows('alarm_suggestions')[0].result_value, null);
});

test('고쳐 적용: 5분만 → 당김 5, 제안은 EDITED', async () => {
  const db = seed();
  const res = await runSuggestApply(ctxOf(db), { suggestionId: 's1', action: 'EDIT', minutes: 5 });
  assert.deepEqual([prepOf(db, 23), advOf(db, 23)], ['07:40', 5]);
  assert.equal(res.status, 'EDITED');
  assert.equal(db.rows('alarm_suggestions')[0].result_value, '5');
});

test('무시: 알람은 그대로, 제안만 IGNORED', async () => {
  const db = seed();
  const res = await runSuggestApply(ctxOf(db), { suggestionId: 's1', action: 'IGNORE' });
  assert.deepEqual([prepOf(db, 23), advOf(db, 23), res.status], ['07:45', 0, 'IGNORED']);
});

test('상태가 안 맞으면 CONFLICT, 없는 제안은 NOT_FOUND, 다른 종류는 UNPROCESSABLE', async () => {
  await assert.rejects(runSuggestApply(ctxOf(seed('APPLIED')), { suggestionId: 's1', action: 'APPLY' }), { code: 'CONFLICT' });
  await assert.rejects(runSuggestApply(ctxOf(seed('PENDING')), { suggestionId: 's1', action: 'REVERT' }), { code: 'CONFLICT' });
  await assert.rejects(runSuggestApply(ctxOf(seed()), { suggestionId: 'nope', action: 'APPLY' }), { code: 'NOT_FOUND' });
  const other = seed();
  other.rows('alarm_suggestions')[0].suggestion_type = 'SOUND';
  await assert.rejects(runSuggestApply(ctxOf(other), { suggestionId: 's1', action: 'APPLY' }), { code: 'UNPROCESSABLE' });
});

test('할 일이 있는 회차: 당긴 준비 알람이 회의 안으로 들어가면 그 회차는 알람 · 당김 분 모두 그대로, 회의 뒤면 당김 (기상은 안 당김)', async () => {
  // 24일만 기상 7:25 뒤 7:28~7:40 회의 → 준비 7:45
  const plan = { lead_minutes: 3, items: [{ title: '회의', start: kst(24, 7, 28), end: kst(24, 7, 40), before_prepare: true, source: 'USER' }] };
  const db = seed();
  db.rows('appointment_participants').find((p) => p.participant_id === 'pt24')!.activity_plan = plan;
  await runSuggestApply(ctxOf(db), { suggestionId: 's1', action: 'APPLY' }); // 10분 → 7:35는 회의 중
  assert.deepEqual([prepOf(db, 23), advOf(db, 23), prepOf(db, 24), advOf(db, 24)], ['07:35', 10, '07:45', 0]);
  assert.equal(hm(db.rows('alarms').find((a) => a.alarm_id === 'w24')!.scheduled_at as string), '07:25');

  const db2 = seed();
  db2.rows('appointment_participants').find((p) => p.participant_id === 'pt24')!.activity_plan = plan;
  await runSuggestApply(ctxOf(db2), { suggestionId: 's1', action: 'EDIT', minutes: 5 }); // 5분 → 7:40 = 회의 끝, 그대로 당김
  assert.deepEqual([prepOf(db2, 24), advOf(db2, 24)], ['07:40', 5]);
});
