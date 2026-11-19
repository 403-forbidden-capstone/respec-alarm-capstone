// 폰 네이티브가 앱 없이 올리는 기록 (알림 버튼 · 자동 기상 확정) — 번호 충돌 무시 · 남의 알람 건너뜀 · 빈 칸만 채움 · 앱 길과 겹쳐도 한 줄 (device-events.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recordDeviceEvents } from './device-events.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const OTHERS = '00000000-0000-4000-8000-0000000000b1';
const E1 = '4b7f478f-5a2a-542a-92dc-9be071c05742';
const E2 = '9070d2b1-d569-5c26-acb3-e2e41be9c886';

function seed() {
  const db = new FakeDb();
  for (const u of [A, B]) db.rows('profiles').push({ user_id: u, timezone: 'Asia/Seoul' });
  db.rows('alarms').push({ alarm_id: MINE, user_id: A, alarm_type: 'DEPARTURE', is_enabled: true }, { alarm_id: OTHERS, user_id: B, alarm_type: 'DEPARTURE', is_enabled: true });
  return db;
}
const tap = (over: Record<string, unknown> = {}) => ({
  alarm_id: MINE,
  client_event_id: E1,
  event_type: 'ACKNOWLEDGED',
  event_at: '2026-11-19T07:25:00.000Z',
  sequence_no: 1,
  input_source: 'BUTTON',
  ...over,
});

test('알림 버튼 기록이 alarm_events로 — 키 주인의 user_id로 들어가고 같은 번호를 다시 보내도 한 줄', async () => {
  const db = seed();
  const out = await recordDeviceEvents(db as never, A, { events: [tap()] });
  assert.deepEqual(out, { stored: 1, skipped: 0, wake_recorded: false });
  await recordDeviceEvents(db as never, A, { events: [tap()] }); // 앱(JS)이 나중에 같은 번호로 올리는 것과 같은 결과
  const rows = db.rows('alarm_events');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, A);
  assert.equal(rows[0].client_event_id, E1);
  assert.equal(rows[0].event_type, 'ACKNOWLEDGED');
  assert.equal(rows[0].input_source, 'BUTTON');
});

test('남의 알람 · 없는 알람의 기록은 건너뜀 (서버 키로 쓰므로 알람 주인을 직접 확인)', async () => {
  const db = seed();
  const out = await recordDeviceEvents(db as never, A, { events: [tap({ alarm_id: OTHERS }), tap({ alarm_id: '00000000-0000-4000-8000-0000000000ff', client_event_id: E2 })] });
  assert.deepEqual(out, { stored: 0, skipped: 2, wake_recorded: false });
  assert.equal(db.rows('alarm_events').length, 0);
});

test('자동 기상 확정 — 그날 기록의 빈 칸 먼저 · 이벤트는 그 뒤, 이미 있는 값은 덮지 않음', async () => {
  const db = seed();
  const wake = { alarm_id: MINE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:30.000Z', wake_reported_at: '2026-11-19T06:30:00.000Z' };
  const event = tap({ event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: wake.wake_confirmed_at, input_source: 'USAGE' });
  const out = await recordDeviceEvents(db as never, A, { events: [event], wake });
  assert.deepEqual(out, { stored: 1, skipped: 0, wake_recorded: true });
  assert.ok(db.calls.indexOf('upsert alarm_events') > db.calls.indexOf('insert daily_records'), db.calls.join(' | '));
  const [record] = db.rows('daily_records');
  assert.equal(record.wake_confirmed_at, wake.wake_confirmed_at);
  assert.equal(record.wake_reported_at, wake.wake_reported_at);
  assert.equal(record.data_source, 'ALARM');

  // 다시 보내도 · 더 늦은 값을 보내도 처음 값 그대로, 이벤트도 한 줄
  await recordDeviceEvents(db as never, A, { events: [event], wake: { ...wake, wake_confirmed_at: '2026-11-19T06:50:00.000Z' } });
  assert.equal(db.rows('daily_records').length, 1);
  assert.equal(db.rows('daily_records')[0].wake_confirmed_at, wake.wake_confirmed_at);
  assert.equal(db.rows('alarm_events').length, 1);
  assert.equal(db.rows('alarm_events')[0].input_source, 'USAGE');
});

test('앱이 먼저 쓴 확정(같은 번호)이 있으면 폰 기록은 무시 · 해제 시각 칸만 비었으면 그것만 채움', async () => {
  const db = seed();
  db.rows('daily_records').push({ user_id: A, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:00.000Z', wake_reported_at: null, data_source: 'ALARM' });
  db.rows('alarm_events').push({ user_id: A, alarm_id: MINE, client_event_id: E2, event_type: 'WAKE_CONFIRMED', event_at: '2026-11-19T06:31:00.000Z', input_source: 'USAGE' });
  const wake = { alarm_id: MINE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:35:00.000Z', wake_reported_at: '2026-11-19T06:30:00.000Z' };
  await recordDeviceEvents(db as never, A, { events: [tap({ event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: wake.wake_confirmed_at, input_source: 'USAGE' })], wake });
  assert.equal(db.rows('alarm_events').length, 1);
  assert.equal(db.rows('alarm_events')[0].event_at, '2026-11-19T06:31:00.000Z');
  assert.equal(db.rows('daily_records')[0].wake_confirmed_at, '2026-11-19T06:31:00.000Z');
  assert.equal(db.rows('daily_records')[0].wake_reported_at, wake.wake_reported_at);
});

test('남의 알람의 기상 확정은 그날 기록도 안 씀', async () => {
  const db = seed();
  const out = await recordDeviceEvents(db as never, A, { wake: { alarm_id: OTHERS, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:00.000Z' } });
  assert.equal(out.wake_recorded, false);
  assert.equal(db.rows('daily_records').length, 0);
});

test('모양이 틀리면 400 — 종류 밖 이벤트(TRIGGERED) · 번호 형식 · 시각 형식 · 빈 요청', async () => {
  const db = seed();
  const bad = (body: unknown) => assert.rejects(recordDeviceEvents(db as never, A, body), (e) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
  await bad({ events: [tap({ event_type: 'TRIGGERED' })] });
  await bad({ events: [tap({ client_event_id: 'abc' })] });
  await bad({ events: [tap({ event_at: '내일 아침' })] });
  await bad({ events: [tap({ input_source: 'LOCATION' })] });
  await bad({ wake: { alarm_id: MINE, record_date: '11/19', wake_confirmed_at: '2026-11-19T06:31:00.000Z' } });
  await bad({});
  await bad({ events: Array.from({ length: 21 }, () => tap()) });
  assert.equal(db.rows('alarm_events').length, 0);
});
