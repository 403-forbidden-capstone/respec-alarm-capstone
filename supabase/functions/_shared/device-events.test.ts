// 폰 네이티브가 앱 없이 올리는 기록 (알림 버튼 · 자동 기상 확정) — 번호 충돌 무시 · 남의 알람 건너뜀 · 빈 칸만 채움 · 앱 길과 겹쳐도 한 줄 (device-events.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deviceEventAllowed, recordDeviceEvents, wakeDay } from './device-events.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { Db } from './supabase.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const WAKE = '00000000-0000-4000-8000-0000000000a2';
const OTHERS = '00000000-0000-4000-8000-0000000000b1';
const E1 = '4b7f478f-5a2a-542a-92dc-9be071c05742';
const E2 = '9070d2b1-d569-5c26-acb3-e2e41be9c886';

function seed() {
  const db = new FakeDb();
  for (const u of [A, B]) db.rows('profiles').push({ user_id: u, timezone: 'Asia/Seoul' });
  db.rows('alarms').push({ alarm_id: MINE, user_id: A, alarm_type: 'DEPARTURE', is_enabled: true }, { alarm_id: WAKE, user_id: A, alarm_type: 'WAKE', is_enabled: true }, { alarm_id: OTHERS, user_id: B, alarm_type: 'DEPARTURE', is_enabled: true });
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
  const wake = { alarm_id: WAKE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:30.000Z', wake_reported_at: '2026-11-19T06:30:00.000Z' };
  const event = tap({ alarm_id: WAKE, event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: wake.wake_confirmed_at, input_source: 'USAGE' });
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
  db.rows('alarm_events').push({ user_id: A, alarm_id: WAKE, client_event_id: E2, event_type: 'WAKE_CONFIRMED', event_at: '2026-11-19T06:31:00.000Z', input_source: 'USAGE' });
  const wake = { alarm_id: WAKE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:35:00.000Z', wake_reported_at: '2026-11-19T06:30:00.000Z' };
  await recordDeviceEvents(db as never, A, { events: [tap({ alarm_id: WAKE, event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: wake.wake_confirmed_at, input_source: 'USAGE' })], wake });
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

test('모양이 틀리면 400 — 종류 밖 이벤트(SNOOZE) · 번호 형식 · 시각 형식 · 빈 요청', async () => {
  const db = seed();
  const bad = (body: unknown) => assert.rejects(recordDeviceEvents(db as never, A, body), (e) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
  await bad({ events: [tap({ event_type: 'SNOOZE' })] });
  await bad({ events: [tap({ client_event_id: 'abc' })] });
  await bad({ events: [tap({ event_at: '내일 아침' })] });
  await bad({ events: [tap({ input_source: 'LOCATION' })] });
  await bad({ wake: { alarm_id: MINE, record_date: '11/19', wake_confirmed_at: '2026-11-19T06:31:00.000Z' } });
  await bad({});
  await bad({ events: Array.from({ length: 21 }, () => tap()) });
  assert.equal(db.rows('alarm_events').length, 0);
});

test('받는 조합은 폰이 보내는 것만 — WAKE_CONFIRMED는 WAKE 알람 + USAGE, 해제는 기상 · 준비 · 출발 알람 + BUTTON, 울림 · 미루기는 네 알람 + BUTTON, 버튼은 BUTTON (나머지는 건너뜀, 개수에 안 셈)', async () => {
  assert.equal(deviceEventAllowed('WAKE_CONFIRMED', 'USAGE', 'WAKE'), true);
  assert.equal(deviceEventAllowed('WAKE_CONFIRMED', 'BUTTON', 'WAKE'), false); // 직접 응답 확정은 앱 화면(로그인 토큰)만
  assert.equal(deviceEventAllowed('WAKE_CONFIRMED', 'USAGE', 'DEPARTURE'), false);
  assert.equal(deviceEventAllowed('DISMISSED', 'BUTTON', 'WAKE'), true);
  assert.equal(deviceEventAllowed('DISMISSED', 'BUTTON', 'PREPARE'), true); // 준비 알람 해제 = 준비 시작
  assert.equal(deviceEventAllowed('DISMISSED', 'BUTTON', 'DEPARTURE'), true); // 출발 알람 해제는 기록용 (출발은 위치 · ACKNOWLEDGED)
  assert.equal(deviceEventAllowed('DISMISSED', 'BUTTON', 'ARRIVE'), false); // 도착은 알림 버튼(ARRIVAL_CONFIRMED)
  assert.equal(deviceEventAllowed('DISMISSED', 'BUTTON', 'ROUTINE'), false);
  assert.equal(deviceEventAllowed('DISMISSED', 'USAGE', 'WAKE'), false);
  assert.equal(deviceEventAllowed('ACKNOWLEDGED', 'BUTTON', 'PREPARE'), true);
  assert.equal(deviceEventAllowed('ARRIVAL_CONFIRMED', 'BUTTON', 'ARRIVE'), true);
  assert.equal(deviceEventAllowed('ACKNOWLEDGED', 'USAGE', 'PREPARE'), false);
  for (const type of ['TRIGGERED', 'SNOOZED']) {
    for (const alarm of ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']) assert.equal(deviceEventAllowed(type, 'BUTTON', alarm), true, `${type} ${alarm}`);
    assert.equal(deviceEventAllowed(type, 'BUTTON', 'ROUTINE'), false);
    assert.equal(deviceEventAllowed(type, 'USAGE', 'WAKE'), false);
    assert.equal(deviceEventAllowed(type, 'LOCATION', 'WAKE'), false);
  }

  const db = seed();
  const out = await recordDeviceEvents(db as never, A, {
    events: [
      tap(), // 통과
      tap({ client_event_id: E2, event_type: 'WAKE_CONFIRMED', input_source: 'BUTTON', alarm_id: WAKE }), // 거절 (출처)
      tap({ client_event_id: '5b7f478f-5a2a-542a-92dc-9be071c05743', event_type: 'WAKE_CONFIRMED', input_source: 'USAGE' }), // 거절 (WAKE 알람 아님)
      tap({ client_event_id: '6b7f478f-5a2a-542a-92dc-9be071c05744', event_type: 'DISMISSED', alarm_id: MINE, input_source: 'USAGE' }), // 거절 (해제는 BUTTON만)
    ],
  });
  assert.deepEqual(out, { stored: 1, skipped: 0, wake_recorded: false });
  assert.equal(db.rows('alarm_events').length, 1);
});

test('wake는 WAKE 알람만 — 다른 종류 알람이면 그날 기록을 안 씀', async () => {
  const db = seed();
  const out = await recordDeviceEvents(db as never, A, { wake: { alarm_id: MINE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:00.000Z' } });
  assert.equal(out.wake_recorded, false);
  assert.equal(db.rows('daily_records').length, 0);
});

test('그날 기록 만들기가 겹쳐(23505) 그 사이 다른 곳이 먼저 만들었으면 빈 칸만 채움', async () => {
  const db = seed();
  // 읽을 때는 없었는데 쓰려니 이미 있는 상황 — 첫 읽기는 빈 값, 첫 쓰기는 23505 (그 사이 다른 곳이 만든 줄은 해제 시각만 있음)
  db.rows('daily_records').push({ user_id: A, record_date: '2026-11-19', wake_confirmed_at: null, wake_reported_at: '2026-11-19T06:20:00.000Z', data_source: 'ALARM' });
  let selects = 0;
  const racing = {
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'daily_records') return q;
      return new Proxy(q, {
        get(target, prop) {
          if (prop === 'select') {
            return (...a: unknown[]) => {
              const r = target.select(...a) as Record<string, unknown>;
              selects += 1;
              if (selects === 1) r.maybeSingle = () => Promise.resolve({ data: null, error: null });
              return r;
            };
          }
          if (prop === 'insert') return () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
          return Reflect.get(target, prop);
        },
      });
    },
    rpc: db.rpc.bind(db),
  } as unknown as Db;
  const wake = { alarm_id: WAKE, record_date: '2026-11-19', wake_confirmed_at: '2026-11-19T06:31:00.000Z', wake_reported_at: '2026-11-19T06:30:00.000Z' };
  const out = await recordDeviceEvents(racing, A, { wake });
  assert.equal(out.wake_recorded, true);
  const rows = db.rows('daily_records');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wake_confirmed_at, wake.wake_confirmed_at); // 빈 칸이던 확정 시각만 채움
  assert.equal(rows[0].wake_reported_at, '2026-11-19T06:20:00.000Z'); // 이미 있던 해제 시각은 그대로
});

test('울림 · 미루기 · 해제 기록 — 준비 · 출발 알람도 받고 snooze_minutes는 미루기에만 · 같은 번호는 한 줄, 해제는 도착 알람이면 건너뜀', async () => {
  const db = seed();
  const PREP = '00000000-0000-4000-8000-0000000000a3';
  const ARR = '00000000-0000-4000-8000-0000000000a4';
  db.rows('alarms').push({ alarm_id: PREP, user_id: A, alarm_type: 'PREPARE', is_enabled: true }, { alarm_id: ARR, user_id: A, alarm_type: 'ARRIVE', is_enabled: true });
  const id = (n: number) => `7b7f478f-5a2a-542a-92dc-9be071c057${String(n).padStart(2, '0')}`;
  const events = [
    tap({ alarm_id: PREP, client_event_id: id(1), event_type: 'TRIGGERED' }),
    tap({ alarm_id: PREP, client_event_id: id(2), event_type: 'SNOOZED', snooze_minutes: 5, sequence_no: 2 }),
    tap({ alarm_id: PREP, client_event_id: id(3), event_type: 'DISMISSED', sequence_no: 3 }),
    tap({ alarm_id: MINE, client_event_id: id(4), event_type: 'TRIGGERED' }),
    tap({ alarm_id: MINE, client_event_id: id(5), event_type: 'DISMISSED' }),
    tap({ alarm_id: ARR, client_event_id: id(6), event_type: 'SNOOZED', snooze_minutes: 5 }),
    tap({ alarm_id: ARR, client_event_id: id(7), event_type: 'DISMISSED' }), // 거절 (도착 알람 해제는 안 받음)
    tap({ alarm_id: WAKE, client_event_id: id(8), event_type: 'TRIGGERED', input_source: 'USAGE' }), // 거절 (출처)
  ];
  const out = await recordDeviceEvents(db as never, A, { events });
  assert.deepEqual(out, { stored: 6, skipped: 0, wake_recorded: false });
  await recordDeviceEvents(db as never, A, { events }); // 같은 번호 다시 — 중복 무시
  const rows = db.rows('alarm_events');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.find((r) => r.client_event_id === id(2))?.snooze_minutes, 5);
  assert.equal(rows.find((r) => r.client_event_id === id(1))?.snooze_minutes, null);
});

// ---- G14 기록일 · G9 정정 ----------------------------------------------------------------------

test('G14 wakeDay — 알람 시각 6시간 전 ~ 18시간 뒤면 알람이 울린 날, 아니면 확인한 날 (한국 시간 기준, DB private.wake_day와 같음)', () => {
  const alarm = '2026-11-19T14:50:00.000Z'; // 한국 11/19 23:50
  assert.equal(wakeDay(alarm, '2026-11-19T15:10:00.000Z', 'Asia/Seoul'), '2026-11-19'); // 한국 11/20 00:10 확인 → 알람이 울린 날
  assert.equal(wakeDay(alarm, '2026-11-19T08:50:00.000Z', 'Asia/Seoul'), '2026-11-19'); // 6시간 전 경계(포함)
  assert.equal(wakeDay(alarm, '2026-11-20T08:50:00.000Z', 'Asia/Seoul'), '2026-11-20'); // 18시간 뒤 경계(제외) → 확인한 날
  assert.equal(wakeDay(alarm, '2026-11-20T23:00:00.000Z', 'Asia/Seoul'), '2026-11-21'); // 알람 행이 다음 회차로 재사용된 뒤의 옛 확인 → 확인한 날
  assert.equal(wakeDay(null, '2026-11-19T15:10:00.000Z', 'Asia/Seoul'), '2026-11-20'); // 알람 시각을 모르면 확인한 날
  assert.equal(wakeDay(alarm, '2026-11-19T15:10:00.000Z', 'America/New_York'), '2026-11-19'); // 사람 시간대로 날짜를 셈
});

test('G14 폰이 보낸 record_date는 무시 — 알람 23:50 · 확인 00:10(한국)이면 알람이 울린 날 한 줄만 생김', async () => {
  const db = seed();
  const alarmRow = db.rows('alarms').find((a) => a.alarm_id === WAKE)!;
  alarmRow.scheduled_at = '2026-11-19T14:50:00.000Z';
  const wake = { alarm_id: WAKE, record_date: '2026-11-20', wake_confirmed_at: '2026-11-19T15:10:00.000Z', wake_reported_at: '2026-11-19T14:51:00.000Z' }; // 폰은 확인한 날(11/20)을 보냄
  const out = await recordDeviceEvents(db as never, A, { wake });
  assert.equal(out.wake_recorded, true);
  const rows = db.rows('daily_records');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_date, '2026-11-19');
  assert.equal(rows[0].wake_confirmed_at, wake.wake_confirmed_at);
});

test('G14 사람 시간대가 한국이 아니면 그 시간대의 알람 기준일', async () => {
  const db = seed();
  db.rows('profiles')[0].timezone = 'America/New_York';
  db.rows('alarms').find((a) => a.alarm_id === WAKE)!.scheduled_at = '2026-11-20T04:00:00.000Z'; // 뉴욕 11/19 23:00
  await recordDeviceEvents(db as never, A, { wake: { alarm_id: WAKE, record_date: '2026-11-20', wake_confirmed_at: '2026-11-20T05:30:00.000Z' } }); // 뉴욕 00:30 확인
  assert.equal(db.rows('daily_records')[0].record_date, '2026-11-19');
});

test('G9 정정된 알람의 자동 확정은 거절 — 정정이 확정 시각 뒤에 있으면 이벤트도 하루 기록도 안 씀(skipped로 셈)', async () => {
  const db = seed();
  const confirmedAt = '2026-11-19T06:31:30.000Z';
  db.rows('alarm_events').push({ user_id: A, alarm_id: WAKE, client_event_id: '7b7f478f-5a2a-542a-92dc-9be071c05745', event_type: 'WAKE_CORRECTED', event_at: '2026-11-19T06:40:00.000Z', input_source: 'BUTTON' });
  const event = tap({ alarm_id: WAKE, event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: confirmedAt, input_source: 'USAGE' });
  const out = await recordDeviceEvents(db as never, A, { events: [event], wake: { alarm_id: WAKE, record_date: '2026-11-19', wake_confirmed_at: confirmedAt } });
  assert.deepEqual(out, { stored: 0, skipped: 1, wake_recorded: false });
  assert.equal(db.rows('alarm_events').filter((e) => e.event_type === 'WAKE_CONFIRMED').length, 0);
  assert.equal(db.rows('daily_records').length, 0);
});

test('G9 정정 뒤 다시 해제해서 나온 새 판정 · 다음 날 판정은 통과 (정정은 그 확정 시각 뒤 1일 안만 막음)', async () => {
  const db = seed();
  db.rows('alarm_events').push({ user_id: A, alarm_id: WAKE, client_event_id: '7b7f478f-5a2a-542a-92dc-9be071c05745', event_type: 'WAKE_CORRECTED', event_at: '2026-11-19T06:40:00.000Z', input_source: 'BUTTON' });
  const confirm = (id: string, at: string) => tap({ alarm_id: WAKE, event_type: 'WAKE_CONFIRMED', client_event_id: id, event_at: at, input_source: 'USAGE' });
  const later = await recordDeviceEvents(db as never, A, { events: [confirm(E2, '2026-11-19T06:55:00.000Z')] }); // 정정 뒤 다시 해제 → 새 판정
  assert.equal(later.stored, 1);
  const nextDay = await recordDeviceEvents(db as never, A, { events: [confirm(E1, '2026-11-20T06:31:00.000Z')] }); // 알람 행이 다음 회차로 재사용된 다음 날
  assert.equal(nextDay.stored, 1);
});

test('G9 정정은 본인 알람의 정정만 봄 — 남의 정정 기록은 내 자동 확정을 막지 않음', async () => {
  const db = seed();
  db.rows('alarm_events').push({ user_id: B, alarm_id: WAKE, client_event_id: '7b7f478f-5a2a-542a-92dc-9be071c05745', event_type: 'WAKE_CORRECTED', event_at: '2026-11-19T06:40:00.000Z', input_source: 'BUTTON' });
  const out = await recordDeviceEvents(db as never, A, { events: [tap({ alarm_id: WAKE, event_type: 'WAKE_CONFIRMED', client_event_id: E2, event_at: '2026-11-19T06:31:30.000Z', input_source: 'USAGE' })] });
  assert.equal(out.stored, 1);
});
