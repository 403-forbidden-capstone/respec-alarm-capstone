import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { Reader } from './read.ts';
import { readCommitRequest, readSuggestRequest } from './requests.ts';

const ID = '11111111-1111-4111-8111-111111111111';

const NEW_BODY = {
  appointment: {
    title: '팀 주간회의',
    appointment_at: '2026-10-20T10:00:00+09:00',
    destination: { name: '세종대학교', lat: 37.55, lng: 127.07 },
    importance: 'NORMAL',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
  },
  participant: { origin: { name: '집', lat: 37.5, lng: 127 }, transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 60, buffer_minutes: 10 },
  kinds: ['WAKE', 'PREPARE', 'DEPARTURE'],
  edits: [{ screen: 'H05', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: '2026-10-20T08:00:00+09:00', edited_value: '2026-10-20T07:30:00+09:00' }],
};

test('suggest: 새 일정은 시각 · 장소가 필수, 이동 · 준비 직접 입력은 MANUAL (commit과 같은 초안 모양)', () => {
  const r = Reader.root({
    appointment: {
      appointment_at: '2026-10-20T10:00:00+09:00',
      destination: { name: '세종대학교', lat: 37.55, lng: 127.07 },
      importance: 'HIGH',
    },
    participant: { origin: { name: '집' }, transport_type: 'TRANSIT', buffer_minutes: 10, est_travel_minutes: 70, travel_source: 'MANUAL', prepare_minutes: 40 },
    kinds: ['WAKE'],
    manual_times: { WAKE: '2026-10-20T07:30:00+09:00' },
  });
  const d = readSuggestRequest(r);
  r.finish();
  assert.equal(d.at?.toISOString(), '2026-10-20T01:00:00.000Z');
  assert.deepEqual(d.destination, { name: '세종대학교', lat: 37.55, lng: 127.07 });
  assert.equal(d.importance, 'HIGH');
  assert.deepEqual([d.travelMinutes, d.travelSource, d.prepareMinutes], [70, 'MANUAL', 40]);
  assert.deepEqual(d.kinds, ['WAKE']);
  assert.equal(d.transport, 'TRANSIT');
});

test('suggest: 필수 값이 없으면 어느 칸인지 알려 줌 (제목은 미리 보기에 필요 없음)', () => {
  const none = Reader.root({});
  readSuggestRequest(none);
  assert.throws(
    () => none.finish(),
    (e: unknown) => e instanceof HttpError && (e.details as { issues: { path: string }[] }).issues.map((i) => i.path).join() === 'appointment_id',
  );
  const empty = Reader.root({ appointment: {} });
  readSuggestRequest(empty);
  assert.throws(
    () => empty.finish(),
    (e: unknown) => e instanceof HttpError && (e.details as { issues: { path: string }[] }).issues.map((i) => i.path).join() === 'appointment.appointment_at,appointment.destination',
  );
});

test('suggest: 기존 약속(appointment_id)이면 시각 · 장소 · 중요도는 DB 값 — appointment를 같이 보내면 거절 (D41, commit과 같음)', () => {
  const r = Reader.root({ appointment_id: ID, participant: { buffer_minutes: 20 } });
  const d = readSuggestRequest(r);
  r.finish();
  assert.deepEqual(d, { appointmentId: ID, bufferMinutes: 20 });

  const both = Reader.root({ appointment_id: ID, appointment: { appointment_at: '2026-10-25T10:00:00+09:00', destination: { name: '딴 곳' } } });
  readSuggestRequest(both);
  assert.throws(() => both.finish(), HttpError);
});

test('suggest: 예전 모양(루트의 appointment_at · destination · travel_minutes_override)은 읽지 않음', () => {
  const r = Reader.root({ appointment_at: '2026-10-20T10:00:00+09:00', destination: { name: '세종대학교' }, travel_minutes_override: 70 });
  readSuggestRequest(r);
  assert.throws(() => r.finish(), HttpError); // appointment_id 또는 appointment가 필요
});

test('commit: 새 약속 + 참여 조건 + 알람 종류 + 고친 값 기록 (D44 반복 규칙)', () => {
  const r = Reader.root(NEW_BODY);
  const c = readCommitRequest(r);
  r.finish();
  assert.equal(c.type, 'APPOINTMENT');
  if (c.type !== 'APPOINTMENT') return;
  assert.deepEqual(c.appointment, { title: '팀 주간회의', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU' });
  assert.equal(c.draft.at?.toISOString(), '2026-10-20T01:00:00.000Z');
  assert.deepEqual([c.draft.travelMinutes, c.draft.travelSource, c.draft.prepareMinutes, c.draft.bufferMinutes], [50, 'API', 60, 10]);
  assert.deepEqual(c.draft.origin, { name: '집', lat: 37.5, lng: 127 });
  assert.equal(c.replaceExisting, true);
  assert.deepEqual(c.edits, [
    { screen: 'H05', field: 'scheduled_at', alarmType: 'WAKE', autoValue: '2026-10-20T08:00:00+09:00', editedValue: '2026-10-20T07:30:00+09:00' },
  ]);
});

test('commit: 기존 약속에 내 참여 조건을 더함 (공동 약속 각자 계산) — 약속 정보를 같이 보내면 거절', () => {
  const ok = Reader.root({ appointment_id: ID, participant: { transport_type: 'CAR' } });
  const c = readCommitRequest(ok);
  ok.finish();
  assert.equal(c.type === 'APPOINTMENT' && c.draft.appointmentId, ID);
  assert.equal(c.type === 'APPOINTMENT' && c.appointment, undefined);

  const both = Reader.root({ appointment_id: ID, appointment: NEW_BODY.appointment });
  readCommitRequest(both);
  assert.throws(() => both.finish(), HttpError);
  const neither = Reader.root({});
  readCommitRequest(neither);
  assert.throws(() => neither.finish(), HttpError);
});

test('commit: 이동시간은 출처와 같이, CACHED · ESTIMATE는 받지 않음 (D5)', () => {
  for (const source of ['CACHED', 'ESTIMATE']) {
    const r = Reader.root({ ...NEW_BODY, participant: { est_travel_minutes: 40, travel_source: source } });
    readCommitRequest(r);
    assert.throws(() => r.finish(), HttpError, source);
  }
  const lonely = Reader.root({ ...NEW_BODY, participant: { est_travel_minutes: 40 } });
  readCommitRequest(lonely);
  assert.throws(() => lonely.finish(), HttpError);
});

test('commit: 일정 없는 알람(D46) — 시각 필수, 반복 규칙, 고치기는 alarm_id', () => {
  const create = Reader.root({ type: 'STANDALONE', alarm: { scheduled_at: '2026-10-20T07:00:00+09:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', levels: { vibration: 2 } } });
  const c = readCommitRequest(create);
  create.finish();
  assert.equal(c.type, 'STANDALONE');
  assert.deepEqual(c.type === 'STANDALONE' && c.alarm.levels, { vibration: 2 });
  assert.equal(c.type === 'STANDALONE' && c.alarm.recurrenceRule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');

  const noTime = Reader.root({ type: 'STANDALONE', alarm: { recurrence_rule: 'FREQ=DAILY' } });
  readCommitRequest(noTime);
  assert.throws(() => noTime.finish(), HttpError);

  const edit = Reader.root({ type: 'STANDALONE', alarm: { alarm_id: ID, is_enabled: false, recurrence_rule: null } });
  const e = readCommitRequest(edit);
  edit.finish();
  assert.deepEqual(e.type === 'STANDALONE' && e.alarm, { alarmId: ID, recurrenceRule: null, isEnabled: false });
});

test('commit: 고친 값 기록의 값 이름은 소문자 · 숫자 · _만, 화면은 H03 · H05 · S01만', () => {
  const r = Reader.root({ ...NEW_BODY, edits: [{ screen: 'H09', field: 'Scheduled At' }, { screen: 'S01', field: 'intensity', edited_value: null }] });
  const c = readCommitRequest(r);
  assert.throws(() => r.finish(), HttpError);
  assert.equal(r.issues.length, 2);
  assert.equal(c.type === 'APPOINTMENT' && c.edits.length, 1); // 올바른 한 줄만 남음
});

test('suggest · commit: 같은 초안을 보내면 같은 계산 입력이 됨 (title · edits · replace_existing은 commit만 씀)', () => {
  const suggest = readSuggestRequest(Reader.root(NEW_BODY));
  const c = readCommitRequest(Reader.root(NEW_BODY));
  assert.equal(c.type, 'APPOINTMENT');
  if (c.type !== 'APPOINTMENT') return;
  assert.deepEqual(suggest, c.draft);

  const existing = { appointment_id: ID, participant: { transport_type: 'CAR', buffer_minutes: 5 }, levels: { vibration: 2 }, manual_times: { WAKE: '2026-10-20T07:30:00+09:00' } };
  const c2 = readCommitRequest(Reader.root(existing));
  assert.deepEqual(readSuggestRequest(Reader.root(existing)), c2.type === 'APPOINTMENT' ? c2.draft : null);
});
