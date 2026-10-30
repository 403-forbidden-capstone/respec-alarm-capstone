// 일정 수정 · 삭제의 순수 계산 (edit.ts) — 표로 확인
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFIRM_MOVE_MINUTES,
  alarmChanges,
  applyPatch,
  deleteMode,
  editorVerdict,
  laterRowsToDelete,
  needsConfirm,
  pickBaseRow,
  scopeEffect,
  wakeAction,
  wakesOfRows,
  type SeriesRow,
} from './edit.ts';

const kst = (local: string) => new Date(`${local}:00+09:00`);
const iso = (local: string) => kst(local).toISOString();

// ---- 범위 효과 ----

test('scopeEffect: 반복 일정은 이번만 = 그 행만 + 이번만 고침 표시 / 이후 모두 = 이 행이 새 기준(표시 지움) + 뒤 회차 지움', () => {
  const rule = 'FREQ=WEEKLY;BYDAY=TU,TH';
  const base = { recurring: true, group: false, currentRule: rule };
  assert.deepEqual(scopeEffect({ ...base, scope: 'this', patchRule: undefined }), { span: 'ROW', mark: 'EDITED', deleteLater: false, rule: { kind: 'KEEP' } });
  assert.deepEqual(scopeEffect({ ...base, scope: 'following', patchRule: undefined }), { span: 'FROM_HERE', mark: 'CLEAR', deleteLater: true, rule: { kind: 'KEEP' } });
});

test('scopeEffect: 이번만 고칠 때 반복 요일은 무시, 이후 모두면 같은 규칙은 그대로 · 다른 규칙은 새로 · null은 묶음 모든 행의 규칙을 비움', () => {
  const rule = 'FREQ=WEEKLY;BYDAY=TU,TH';
  const base = { recurring: true, group: false, currentRule: rule };
  assert.deepEqual(scopeEffect({ ...base, scope: 'this', patchRule: 'FREQ=DAILY' }).rule, { kind: 'KEEP' });
  assert.deepEqual(scopeEffect({ ...base, scope: 'this', patchRule: null }).rule, { kind: 'KEEP' });
  assert.deepEqual(scopeEffect({ ...base, scope: 'following', patchRule: rule }).rule, { kind: 'KEEP' });
  assert.deepEqual(scopeEffect({ ...base, scope: 'following', patchRule: 'FREQ=DAILY' }).rule, { kind: 'SET', value: 'FREQ=DAILY' });
  assert.deepEqual(scopeEffect({ ...base, scope: 'following', patchRule: null }).rule, { kind: 'CLEAR_ALL' });
});

test('scopeEffect: 한 번짜리는 범위와 상관없이 그 행 하나(반복을 켜면 이 행에 규칙), 공동 약속은 늘 그 행 하나 · 규칙 그대로', () => {
  for (const scope of ['this', 'following'] as const) {
    assert.deepEqual(scopeEffect({ recurring: false, group: false, scope, patchRule: undefined, currentRule: null }), { span: 'ROW', mark: 'KEEP', deleteLater: false, rule: { kind: 'KEEP' } });
    assert.deepEqual(scopeEffect({ recurring: false, group: false, scope, patchRule: 'FREQ=DAILY', currentRule: null }).rule, { kind: 'SET', value: 'FREQ=DAILY' });
    assert.deepEqual(scopeEffect({ recurring: false, group: false, scope, patchRule: null, currentRule: null }).rule, { kind: 'KEEP' });
    assert.deepEqual(scopeEffect({ recurring: false, group: true, scope, patchRule: 'FREQ=DAILY', currentRule: 'FREQ=DAILY' }), { span: 'ROW', mark: 'KEEP', deleteLater: false, rule: { kind: 'KEEP' } });
  }
});

test('deleteMode: 반복 + 이번만 = 알람만 지움(행은 둠), 반복 + 이후 모두 = 뒤 회차부터 지움, 한 번짜리 · 공동 약속 = 행 지움', () => {
  assert.equal(deleteMode({ recurring: true, group: false, scope: 'this' }), 'CANCEL_THIS');
  assert.equal(deleteMode({ recurring: true, group: false, scope: 'following' }), 'FROM_HERE');
  assert.equal(deleteMode({ recurring: false, group: false, scope: 'this' }), 'ROW');
  assert.equal(deleteMode({ recurring: false, group: false, scope: 'following' }), 'ROW');
  assert.equal(deleteMode({ recurring: true, group: true, scope: 'following' }), 'ROW');
});

test('editorVerdict: 만든 사람만 · 못 찾음 · 공동 약속의 참여만 한 사람', () => {
  assert.equal(editorVerdict({ row: null, userId: 'a' }), 'NOT_VISIBLE');
  assert.equal(editorVerdict({ row: { creator_id: 'a', group_id: null }, userId: 'a' }), 'OK');
  assert.equal(editorVerdict({ row: { creator_id: 'a', group_id: 'g' }, userId: 'a' }), 'OK');
  assert.equal(editorVerdict({ row: { creator_id: 'a', group_id: 'g' }, userId: 'b' }), 'NOT_CREATOR');
});

// ---- 고친 값 반영 ----

const ROW = { title: '세미나', appointment_at: iso('2026-10-29T09:00'), dest_name: '세종대학교', dest_lat: '37.550000', dest_lng: 127.07, importance: 'NORMAL' as const };

test('applyPatch: 안 넣은 칸은 그대로, 같은 값은 바뀐 것이 아님 (numeric이 글자로 와도 같은 좌표로 봄)', () => {
  const same = applyPatch(ROW, { title: '  세미나 ', at: kst('2026-10-29T09:00'), destination: { name: '세종대학교', lat: 37.55, lng: 127.07 }, importance: 'NORMAL' });
  assert.equal(same.any, false);
  assert.deepEqual(same.changed, { title: false, at: false, place: false, importance: false });
  assert.equal(same.affectsAlarms, false);
  assert.deepEqual(applyPatch(ROW, {}).next, { title: '세미나', appointment_at: ROW.appointment_at, dest_name: '세종대학교', dest_lat: 37.55, dest_lng: 127.07, importance: 'NORMAL' });
});

test('applyPatch: 제목만 바뀌면 알람은 안 건드림, 시각 · 장소 · 중요도는 알람을 다시 계산', () => {
  const title = applyPatch(ROW, { title: '발표' });
  assert.deepEqual([title.any, title.affectsAlarms, title.next.title], [true, false, '발표']);
  assert.equal(applyPatch(ROW, { at: kst('2026-10-29T10:00') }).affectsAlarms, true);
  assert.equal(applyPatch(ROW, { importance: 'HIGH' }).affectsAlarms, true);
  const place = applyPatch(ROW, { destination: { name: '강남역', lat: 37.4979, lng: 127.0276 } });
  assert.deepEqual([place.changed.place, place.affectsAlarms, place.next.dest_name, place.next.dest_lat], [true, true, '강남역', 37.4979]);
});

test('applyPatch: 장소 이름만 바뀌고 좌표가 없으면 옛 좌표는 비움 (다른 곳의 좌표를 안 남김)', () => {
  const r = applyPatch(ROW, { destination: { name: '도서관' } });
  assert.deepEqual([r.changed.place, r.next.dest_lat, r.next.dest_lng], [true, null, null]);
  // 같은 이름 · 같은 좌표를 다시 보내면 바뀐 것이 아님
  assert.equal(applyPatch(ROW, { destination: { name: '세종대학교', lat: 37.55, lng: 127.07 } }).changed.place, false);
  // 이름은 같은데 좌표만 달라도 바뀐 것
  assert.equal(applyPatch(ROW, { destination: { name: '세종대학교', lat: 37.56, lng: 127.07 } }).changed.place, true);
});

// ---- 바뀌는 알람 · 확인 ----

const before = [
  { alarm_type: 'WAKE' as const, scheduled_at: iso('2026-10-29T07:25') },
  { alarm_type: 'PREPARE' as const, scheduled_at: iso('2026-10-29T07:55') },
  { alarm_type: 'DEPARTURE' as const, scheduled_at: iso('2026-10-29T08:15') },
  { alarm_type: 'ARRIVE' as const, scheduled_at: iso('2026-10-29T08:50') },
];
const moved = (minutes: number, over: Partial<Record<string, boolean>> = {}) =>
  before.map((b) => ({ alarm_type: b.alarm_type, scheduled_at: new Date(Date.parse(b.scheduled_at) + minutes * 60_000).toISOString(), is_enabled: over[b.alarm_type] ?? true }));

test('alarmChanges: 시각이 바뀌는 기상 · 준비 · 출발만 (도착 목표는 안 셈), 같은 시각이면 빠짐', () => {
  const lines = alarmChanges(before, moved(60));
  assert.deepEqual(lines.map((l) => l.kind), ['WAKE', 'PREPARE', 'DEPARTURE']);
  assert.deepEqual(lines[0], { kind: 'WAKE', from: iso('2026-10-29T07:25'), to: iso('2026-10-29T08:25') });
  assert.deepEqual(alarmChanges(before, moved(0)), []);
  // 기상만 직접 고른 시각이라 안 움직이는 경우
  const keepWake = moved(30).map((a) => (a.alarm_type === 'WAKE' ? { ...a, scheduled_at: before[0].scheduled_at } : a));
  assert.deepEqual(alarmChanges(before, keepWake).map((l) => l.kind), ['PREPARE', 'DEPARTURE']);
});

test('alarmChanges: 새로 생기거나 사라지는 알람(그날 첫 일정이 바뀜) · 꺼지는 알람은 줄에 안 넣음', () => {
  assert.deepEqual(alarmChanges(before, moved(60).filter((a) => a.alarm_type !== 'WAKE')).map((l) => l.kind), ['PREPARE', 'DEPARTURE']);
  assert.deepEqual(alarmChanges(before.filter((a) => a.alarm_type !== 'WAKE'), moved(60)).map((l) => l.kind), ['PREPARE', 'DEPARTURE']);
  assert.deepEqual(alarmChanges(before, moved(60, { WAKE: false, PREPARE: false })).map((l) => l.kind), ['DEPARTURE']);
});

test('needsConfirm: 5분 이상 늦춰질 때만 (앞당김 · 4분 늦춤은 바로 저장) — 앱 CONFIRM_MOVE_MINUTES와 같은 경계', () => {
  assert.equal(CONFIRM_MOVE_MINUTES, 5);
  const cases: [number, boolean][] = [[-60, false], [-5, false], [-1, false], [0, false], [4, false], [5, true], [6, true], [60, true]];
  for (const [minutes, expected] of cases) assert.equal(needsConfirm(alarmChanges(before, moved(minutes))), expected, `${minutes}분`);
  // 한 알람이라도 5분 이상 늦춰지면 확인 (기상은 앞당겨지고 출발은 늦춰짐)
  const mixed = moved(0).map((a) => (a.alarm_type === 'DEPARTURE' ? { ...a, scheduled_at: iso('2026-10-29T08:25') } : a.alarm_type === 'WAKE' ? { ...a, scheduled_at: iso('2026-10-29T07:00') } : a));
  assert.equal(needsConfirm(alarmChanges(before, mixed)), true);
  assert.equal(needsConfirm([]), false);
});

// ---- 이후 모두 — 지울 뒤 회차 ----

const series = (rows: [string, string, SeriesRow['exception_kind']?][]): SeriesRow[] =>
  rows.map(([id, on, exception_kind]) => ({ appointment_id: id, occurrence_on: on, appointment_at: iso(`${on}T09:00`), exception_kind: exception_kind ?? null }));
const NOW = kst('2026-10-26T10:00');

test('laterRowsToDelete: 이 회차보다 뒤 · 지금 이후 · 기록 없는 회차만. 고치기는 예외(이번만 고친 · 지운) 회차를 남기고 지우기는 지움', () => {
  const rows = series([['r1', '2026-10-27'], ['r2', '2026-10-29'], ['r3', '2026-11-03', 'EDITED'], ['r4', '2026-11-05', 'CANCELED'], ['r5', '2026-11-10']]);
  const target = rows[1];
  assert.deepEqual(laterRowsToDelete({ rows, target, now: NOW, recordIds: new Set(), mode: 'EDIT' }), ['r5']);
  assert.deepEqual(laterRowsToDelete({ rows, target, now: NOW, recordIds: new Set(), mode: 'DELETE' }), ['r3', 'r4', 'r5']);
  assert.deepEqual(laterRowsToDelete({ rows, target, now: NOW, recordIds: new Set(['r3', 'r5']), mode: 'DELETE' }), ['r4']); // 기록 있는 회차는 남김
  assert.deepEqual(laterRowsToDelete({ rows, target: rows[4], now: NOW, recordIds: new Set(), mode: 'DELETE' }), []); // 마지막 회차 뒤에는 없음
});

test('laterRowsToDelete: 지난 회차(약속 시각이 지금 이전)는 지우지 않음', () => {
  const rows = series([['r1', '2026-10-20'], ['r2', '2026-10-22'], ['r3', '2026-10-29']]);
  assert.deepEqual(laterRowsToDelete({ rows, target: rows[0], now: NOW, recordIds: new Set(), mode: 'DELETE' }), ['r3']);
});

// ---- 7.1.3 재판정 ----

const W = (id: string, local: string, enabled = true) => ({ appointmentId: id, appointmentAt: kst(local), isEnabled: enabled });

test('wakeAction: 앞 일정이 지워져 이제 첫 일정이 된 일정(전에는 밀려 기상이 없었음)은 기상을 더함', () => {
  const beforeWakes = [W('a1', '2026-10-29T10:00')]; // 전: a1이 첫 일정, a2(13시)는 밀려 있었음
  const verdict = wakeAction({ id: 'a2', at: kst('2026-10-29T13:00'), hasWake: false, beforeWakes, sim: [] }); // 지금: 앞 기상 없음
  assert.deepEqual(verdict, { action: 'ADD', earlierAfter: false });
});

test('wakeAction: 앞에 새 일정이 생기거나 옮겨져 더 이상 첫 일정이 아니면 기상을 뗌', () => {
  const verdict = wakeAction({ id: 'a1', at: kst('2026-10-29T10:00'), hasWake: true, beforeWakes: [W('a1', '2026-10-29T10:00')], sim: [W('a2', '2026-10-29T08:00')] });
  assert.deepEqual(verdict, { action: 'REMOVE', earlierAfter: true });
});

test('wakeAction: 그대로면 NONE — 사용자가 일부러 기상을 안 만든 일정(전에도 밀리지 않았음)은 되살리지 않음, 앞 기상이 꺼져 있으면 앞서지 않은 것', () => {
  // 전에도 지금도 첫 일정인데 기상이 없음 (기상을 안 고른 일정)
  assert.equal(wakeAction({ id: 'a1', at: kst('2026-10-29T10:00'), hasWake: false, beforeWakes: [], sim: [] }).action, 'NONE');
  // 전에도 지금도 밀려 있음
  assert.equal(wakeAction({ id: 'a3', at: kst('2026-10-29T17:00'), hasWake: false, beforeWakes: [W('a1', '2026-10-29T10:00')], sim: [W('a2', '2026-10-29T13:00')] }).action, 'NONE');
  // 앞 일정의 기상이 꺼져 있으면 앞선 기상으로 안 침 (hasEarlierWake 규칙)
  assert.equal(wakeAction({ id: 'a2', at: kst('2026-10-29T13:00'), hasWake: true, beforeWakes: [W('a1', '2026-10-29T10:00', false)], sim: [W('a1', '2026-10-29T10:00', false)] }).action, 'NONE');
  // 같은 시각이면 앞선 것이 아님 → 둘 다 기상을 가짐
  assert.equal(wakeAction({ id: 'a2', at: kst('2026-10-29T10:00'), hasWake: true, beforeWakes: [W('a1', '2026-10-29T10:00')], sim: [W('a1', '2026-10-29T10:00')] }).action, 'NONE');
});

test('wakesOfRows: 기상 알람이 없는 일정은 기상을 안 가짐 (꺼진 기상은 isEnabled false로)', () => {
  const rows = [
    { id: 'a1', at: kst('2026-10-29T10:00'), wakeEnabled: true },
    { id: 'a2', at: kst('2026-10-29T13:00'), wakeEnabled: null },
    { id: 'a3', at: kst('2026-10-29T15:00'), wakeEnabled: false },
  ];
  assert.deepEqual(wakesOfRows(rows).map((w) => [w.appointmentId, w.isEnabled]), [['a1', true], ['a3', false]]);
});

// ---- 기준 회차 ----

test('pickBaseRow: 예외 아닌 회차 중 가장 늦은 행 → 없으면 이번만 고친 행 중 가장 늦은 것 → 지운 회차는 기준이 아님', () => {
  const rows = series([['r1', '2026-11-03'], ['r2', '2026-11-10', 'EDITED'], ['r3', '2026-11-17', 'CANCELED'], ['r0', '2026-10-27']]);
  assert.equal(pickBaseRow(rows)?.appointment_id, 'r1');
  assert.equal(pickBaseRow(rows.filter((r) => r.appointment_id !== 'r1' && r.appointment_id !== 'r0'))?.appointment_id, 'r2'); // 예외뿐 → 이번만 고친 것
  assert.equal(pickBaseRow(series([['x', '2026-11-03', 'CANCELED']])), null);
  assert.equal(pickBaseRow([]), null);
  assert.equal(pickBaseRow(series([['e1', '2026-11-03', 'EDITED'], ['e2', '2026-11-10', 'EDITED']]))?.appointment_id, 'e2');
});
