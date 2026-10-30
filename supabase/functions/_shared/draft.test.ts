import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RRULE_PATTERN, readAlarmFields, readParticipantFields, readPlace, readRecurrence } from './draft.ts';
import { HttpError } from './errors.ts';
import { Reader } from './read.ts';

test('장소: 이름 · 좌표(둘이 같이)', () => {
  const r = Reader.root({ destination: { name: '세종대학교', lat: 37.55, lng: 127.07 }, origin: { name: '집' }, bad: { lat: 37.5 } });
  assert.deepEqual(readPlace(r, 'destination'), { name: '세종대학교', lat: 37.55, lng: 127.07 });
  assert.deepEqual(readPlace(r, 'origin'), { name: '집' });
  assert.equal(readPlace(r, 'missing'), undefined);
  readPlace(r, 'bad');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].path, 'bad.lng');
});

test('범위를 벗어난 좌표는 문제', () => {
  const r = Reader.root({ p: { lat: 91, lng: 127 } });
  readPlace(r, 'p');
  assert.equal(r.issues[0].path, 'p.lat');
});

test('출발 · 이동 · 여유 칸', () => {
  const r = Reader.root({ origin: { name: '학교' }, transport_type: 'CAR', buffer_minutes: 5, before_prepare_minutes: 0, with_wake: false });
  assert.deepEqual(readParticipantFields(r), { origin: { name: '학교' }, transport: 'CAR', bufferMinutes: 5, beforePrepareMinutes: 0, withWake: false });
  assert.deepEqual(readParticipantFields(Reader.root({})), {});
  const bad = Reader.root({ transport_type: 'ROCKET', buffer_minutes: -1 });
  readParticipantFields(bad);
  assert.equal(bad.issues.length, 2);
});

test('알람 칸: 종류 · 켜기 · 직접 시각(null = 자동으로 되돌림) · 강도 단계', () => {
  const r = Reader.root({
    kinds: ['WAKE', 'DEPARTURE'],
    enabled: { WAKE: false },
    manual_times: { WAKE: '2026-10-20T07:30:00+09:00', PREPARE: null },
    levels: { sound: 0, voice: null, vibration: 2 },
  });
  const f = readAlarmFields(r);
  r.finish();
  assert.deepEqual(f.kinds, ['WAKE', 'DEPARTURE']);
  assert.deepEqual(f.enabled, { WAKE: false });
  assert.deepEqual(f.manualTimes, { WAKE: new Date('2026-10-19T22:30:00Z'), PREPARE: null });
  assert.deepEqual(f.levels, { sound: 0, voice: null, vibration: 2 });
});

test('칸이 아예 없으면 undefined — "저장된 값 그대로"와 "전부 자동"을 구분', () => {
  const f = readAlarmFields(Reader.root({}));
  assert.equal(f.kinds, undefined);
  assert.equal(f.manualTimes, undefined);
  assert.equal(f.levels, undefined);
  assert.deepEqual(readAlarmFields(Reader.root({ kinds: [] })).kinds, []);
  assert.deepEqual(readAlarmFields(Reader.root({ manual_times: {} })).manualTimes, {});
});

test('도착은 직접 고르는 종류가 아님 · 강도는 0~2', () => {
  const r = Reader.root({ kinds: ['ARRIVE'], levels: { sound: 3 }, manual_times: { WAKE: '내일 7시' } });
  readAlarmFields(r);
  assert.throws(() => r.finish(), HttpError);
  assert.equal(r.issues.length, 3);
});

test('반복 규칙 (D44): 요일 칩 · 매일 · 평일 — 앱이 만드는 두 모양만', () => {
  for (const ok of ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=TH', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=WEEKLY;BYDAY=SA,SU']) {
    assert.ok(RRULE_PATTERN.test(ok), ok);
  }
  // 두 모양 밖은 거절: 월간 · 연간 · 간격(INTERVAL) · 횟수 · 요일 없는 주간 · 모르는 요일 코드 · 소문자 · RRULE: 접두사
  const bad = ['', 'DAILY', 'FREQ=HOURLY', 'FREQ=DAILY;DROP TABLE', 'BYDAY=MO', 'FREQ=MONTHLY', 'FREQ=MONTHLY;BYMONTHDAY=3', 'FREQ=YEARLY', 'FREQ=WEEKLY',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'FREQ=WEEKLY;BYDAY=TH;COUNT=3', 'FREQ=DAILY;INTERVAL=2', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=WEEKLY;BYDAY=MO,',
    'freq=daily', 'RRULE:FREQ=DAILY', 'FREQ=DAILY ', ' FREQ=DAILY'];
  for (const rule of bad) assert.ok(!RRULE_PATTERN.test(rule), rule);
  assert.equal(readRecurrence(Reader.root({ recurrence_rule: 'FREQ=DAILY' })), 'FREQ=DAILY');
  assert.equal(readRecurrence(Reader.root({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE' })), 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(readRecurrence(Reader.root({ recurrence_rule: null })), null);
  assert.equal(readRecurrence(Reader.root({})), undefined);
  // 두 모양 밖은 읽는 쪽에서 문제로 기록됨 → 요청 전체가 VALIDATION_FAILED
  for (const rule of ['FREQ=MONTHLY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH']) {
    const r = Reader.root({ recurrence_rule: rule });
    readRecurrence(r);
    assert.throws(() => r.finish(), HttpError);
    assert.deepEqual(r.issues.map((i) => i.path), ['recurrence_rule']);
  }
});
