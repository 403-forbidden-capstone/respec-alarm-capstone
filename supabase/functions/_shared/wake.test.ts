// wake-check 본문 — MISSED 기록(중복 무시) · 이름 인자 · 그룹 푸시 후보(사실만 읽고 판정은 DB 함수에) 를 가짜 DB(rpc · upsert 포함)로
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { Db } from './supabase.ts';
import { LOOKBACK_HOURS, missedPushTargets, PUSH_MISSED_TO_GROUP, pushMissedToGroup, runWakeCheck, type MissedRow } from './wake.ts';

const NOW = new Date('2026-10-16T01:00:00.000Z');
const missed = (n: number, over: Partial<MissedRow> = {}): MissedRow => ({
  alarm_id: `alarm-${n}`,
  user_id: `user-${n}`,
  participant_id: null,
  appointment_id: null,
  group_id: null,
  appointment_at: null,
  scheduled_at: '2026-10-16T00:00:00.000Z',
  missed_at: '2026-10-16T00:30:00.000Z',
  event_key: `key-${n}`,
  ...over,
});

function setup(rows: MissedRow[] = []) {
  const db = new FakeDb();
  db.rpcHandlers.find_missed_wake_alarms = () => rows;
  return { db, service: db as unknown as Db };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

test('찾은 알람마다 MISSED를 기록하고, DB 함수는 이름 인자(p_now · p_lookback_hours)로 부름', async () => {
  const { db, service } = setup([missed(1), missed(2)]);
  const result = await runWakeCheck(service, NOW);

  assert.deepEqual(result, { checked: 2, recorded: 2, pushed: 0 });
  assert.deepEqual(db.rpcCalls, [{ name: 'find_missed_wake_alarms', args: { p_now: NOW.toISOString(), p_lookback_hours: LOOKBACK_HOURS } }]);
  const events = db.rows('alarm_events');
  assert.deepEqual(events.map((e) => [e.alarm_id, e.user_id, e.event_type, e.event_at, e.client_event_id, e.input_source]), [
    ['alarm-1', 'user-1', 'MISSED', '2026-10-16T00:30:00.000Z', 'key-1', null],
    ['alarm-2', 'user-2', 'MISSED', '2026-10-16T00:30:00.000Z', 'key-2', null],
  ]);
});

test('겹쳐 돌거나 다시 돌아도 같은 알람의 MISSED는 한 번만 (client_event_id = event_key), 새로 들어간 것만 recorded', async () => {
  const { db, service } = setup([missed(1), missed(2)]);
  await runWakeCheck(service, NOW);

  const again = await runWakeCheck(service, NOW); // 5분 뒤 같은 후보가 또 나옴
  assert.deepEqual(again, { checked: 2, recorded: 0, pushed: 0 });
  assert.equal(db.rows('alarm_events').length, 2);

  db.rpcHandlers.find_missed_wake_alarms = () => [missed(1), missed(2), missed(3)];
  const third = await runWakeCheck(service, NOW);
  assert.deepEqual(third, { checked: 3, recorded: 1, pushed: 0 });
  assert.deepEqual(db.rows('alarm_events').map((e) => e.client_event_id), ['key-1', 'key-2', 'key-3']);
});

test('후보가 없으면 기록 호출 없이 0', async () => {
  const { db, service } = setup([]);
  assert.deepEqual(await runWakeCheck(service, NOW), { checked: 0, recorded: 0, pushed: 0 });
  assert.ok(!db.calls.some((c) => c.startsWith('upsert')));
});

test('DB 함수나 기록이 실패하면 일반 문구의 500', async () => {
  const { db, service } = setup([missed(1)]);
  db.rpcHandlers.find_missed_wake_alarms = () => {
    throw new Error('boom');
  };
  await quiet(() => assert.rejects(() => runWakeCheck(service, NOW), (e: unknown) => e instanceof HttpError && e.status === 500));

  const { db: db2, service: service2 } = setup([missed(1)]);
  db2.failOn = [{ table: 'alarm_events', op: 'upsert' }];
  await quiet(() => assert.rejects(() => runWakeCheck(service2, NOW), (e: unknown) => e instanceof HttpError && e.status === 500));
});

// ---- 그룹 미확인 푸시 (D19 전에는 꺼 둠) ----

const GROUP = 'group-1';
function groupSetup() {
  const row = missed(1, { user_id: 'u1', group_id: GROUP });
  const { db, service } = setup([row]);
  db.rows('group_members').push(
    { group_id: GROUP, user_id: 'u1', invite_status: 'JOINED' }, // 본인은 후보가 아님
    { group_id: GROUP, user_id: 'u2', invite_status: 'JOINED' },
    { group_id: GROUP, user_id: 'u3', invite_status: 'JOINED' },
    { group_id: GROUP, user_id: 'u4', invite_status: 'INVITED' }, // 아직 참여 안 함
    { group_id: 'other-group', user_id: 'u5', invite_status: 'JOINED' },
  );
  // 판정은 DB 함수 몫 — 여기서는 u2에게만 허용으로 흉내
  db.rpcHandlers.can_send_push = (a) => a.p_kind === 'WAKE_MISSED' && a.p_target_id === 'u2';
  return { db, service, row };
}

test('D19 전에는 그룹 푸시를 켜지 않음: 구성원 조회도 can_send_push 호출도 없음', async () => {
  assert.equal(PUSH_MISSED_TO_GROUP, false);
  const { db, service, row } = groupSetup();
  assert.equal(await pushMissedToGroup(service, row), 0);
  const result = await runWakeCheck(service, NOW);
  assert.deepEqual(result, { checked: 1, recorded: 1, pushed: 0 });
  assert.ok(!db.calls.includes('select group_members'));
  assert.ok(!db.rpcCalls.some((c) => c.name === 'can_send_push'));
});

test('받을 사람 후보는 사실만(참여 중인 다른 구성원), 보내도 되는지는 can_send_push 하나가 정함', async () => {
  const { db, service, row } = groupSetup();
  const targets = await missedPushTargets(service, row);

  assert.deepEqual(targets, ['u2']);
  assert.deepEqual(
    db.rpcCalls.map((c) => c.args),
    [
      { p_sender_id: 'u1', p_target_id: 'u2', p_kind: 'WAKE_MISSED' },
      { p_sender_id: 'u1', p_target_id: 'u3', p_kind: 'WAKE_MISSED' },
    ],
  );
  // TS가 권한 표(sharing_permissions)를 다시 읽어 판정하지 않음
  assert.ok(!db.calls.includes('select sharing_permissions'));
});

test('약속 · 그룹이 없는 알람은 후보가 없음, 켜도 아직 보내는 코드는 없어서 pushed는 0 (D19 · D52 뒤에 채움)', async () => {
  const { db, service, row } = groupSetup();
  assert.deepEqual(await missedPushTargets(service, missed(9)), []);
  assert.ok(!db.calls.includes('select group_members'));
  assert.equal(await pushMissedToGroup(service, row, true), 0);
  assert.deepEqual(await runWakeCheck(service, NOW, { pushMissed: true }), { checked: 1, recorded: 1, pushed: 0 });
});
