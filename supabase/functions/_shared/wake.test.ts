// wake-check 본문 — MISSED 기록(중복 무시) · 이름 인자 · 본인 미확인 알림 · 친구 알림('깨워 볼까요?' · 후속)을 가짜 DB(rpc · upsert 포함)와 가짜 Expo 서버로
//   받는 사람을 고르는 판정은 DB 함수 몫(claim_wake_nudges, supabase/tests/friend/ch08.mjs) — 여기서는 DB가 돌려준 행을 문구 · 채널 · 알림 데이터로 보내는 것만
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { Db } from './supabase.ts';
import { LOOKBACK_HOURS, runWakeCheck, type MissedRow, type NudgeRow } from './wake.ts';

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

type Sent = { to: string; title: string; body: string; channelId?: string; data: Record<string, unknown> };

function setup(rows: MissedRow[] = [], nudges: NudgeRow[] = []) {
  const db = new FakeDb();
  db.rpcHandlers.find_missed_wake_alarms = () => rows;
  db.rpcHandlers.claim_wake_nudges = () => nudges;
  const pushes: Sent[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Sent[];
    pushes.push(...body);
    return new Response(JSON.stringify({ data: body.map((b) => ({ status: 'ok', id: `ticket-${b.to.slice(-6, -1)}` })) }));
  };
  const push = { fetchImpl, sleep: async () => {} };
  return { db, service: db as unknown as Db, pushes, push };
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

  assert.deepEqual(result, { checked: 2, recorded: 2, pushed: 0, claimed: 0, nudged: 0 });
  assert.deepEqual(db.rpcCalls[0], { name: 'find_missed_wake_alarms', args: { p_now: NOW.toISOString(), p_lookback_hours: LOOKBACK_HOURS } });
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
  assert.deepEqual(again, { checked: 2, recorded: 0, pushed: 0, claimed: 0, nudged: 0 });
  assert.equal(db.rows('alarm_events').length, 2);

  db.rpcHandlers.find_missed_wake_alarms = () => [missed(1), missed(2), missed(3)];
  const third = await runWakeCheck(service, NOW);
  assert.deepEqual(third, { checked: 3, recorded: 1, pushed: 0, claimed: 0, nudged: 0 });
  assert.deepEqual(db.rows('alarm_events').map((e) => e.client_event_id), ['key-1', 'key-2', 'key-3']);
});

test('후보가 없으면 기록 호출 없이 0 — 친구 알림 판정(claim)은 그래도 돎 (옛 미확인의 10분이 이제야 찬 경우)', async () => {
  const { db, service } = setup([]);
  assert.deepEqual(await runWakeCheck(service, NOW), { checked: 0, recorded: 0, pushed: 0, claimed: 0, nudged: 0 });
  assert.ok(!db.calls.some((c) => c.startsWith('upsert')));
  assert.deepEqual(db.rpcCalls.map((c) => c.name), ['find_missed_wake_alarms', 'claim_wake_nudges']);
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

test('기록이 실패해도 친구 알림 판정은 돌고, 반대로 친구 알림 판정이 실패해도 기록은 남음 — 실패는 그 뒤에 던짐', async () => {
  const a = setup([missed(1)], []);
  a.db.rpcHandlers.find_missed_wake_alarms = () => {
    throw new Error('boom');
  };
  await quiet(() => assert.rejects(() => runWakeCheck(a.service, NOW), (e: unknown) => e instanceof HttpError && e.status === 500));
  assert.ok(a.db.rpcCalls.some((c) => c.name === 'claim_wake_nudges'));

  const b = setup([missed(1)]);
  b.db.rpcHandlers.claim_wake_nudges = () => {
    throw new Error('boom');
  };
  await quiet(() => assert.rejects(() => runWakeCheck(b.service, NOW), (e: unknown) => e instanceof HttpError && e.status === 500));
  assert.equal(b.db.rows('alarm_events').length, 1);
});

// ---- 본인 알림 (8-너) ----

const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const T3 = 'ExponentPushToken[cccccccccccccccccccccc]';

test('8-20: 새로 기록된 미확인의 주인 본인에게만 "기상 확인 / 기상 확인이 안 됐어요" — 본인 기기 전부, 다른 사람 토큰은 안 건드림, 눌러 갈 곳은 H08(/wake)', async () => {
  const { db, service, pushes, push } = setup([missed(1), missed(2)]);
  db.rows('push_tokens').push({ user_id: 'user-1', token: T1 }, { user_id: 'user-1', token: T2 }, { user_id: 'user-3', token: T3 });
  const result = await runWakeCheck(service, NOW, { push });

  assert.deepEqual(result, { checked: 2, recorded: 2, pushed: 2, claimed: 0, nudged: 0 });
  assert.deepEqual(pushes.map((p) => p.to).sort(), [T1, T2]);
  assert.ok(pushes.every((p) => p.title === '기상 확인' && p.body === '기상 확인이 안 됐어요' && p.channelId === 'missed_v1'));
  assert.ok(pushes.every((p) => p.data.kind === 'WAKE_MISSED' && p.data.recipientUserId === 'user-1' && p.data.path === '/wake'));
  // 영수증 표에 종류와 함께 남음
  assert.deepEqual(db.rows('push_tickets').map((t) => [t.user_id, t.kind]), [['user-1', 'WAKE_MISSED'], ['user-1', 'WAKE_MISSED']]);
});

test('8-20: 이미 기록된 미확인(다시 돈 배치)은 본인 알림을 다시 안 보냄, 한 사람의 알람 둘이 같이 미확인이어도 한 번', async () => {
  const { db, service, pushes, push } = setup([missed(1), missed(1, { alarm_id: 'alarm-1b', event_key: 'key-1b' })]);
  db.rows('push_tokens').push({ user_id: 'user-1', token: T1 });
  await runWakeCheck(service, NOW, { push });
  assert.equal(pushes.length, 1);

  await runWakeCheck(service, NOW, { push }); // 5분 뒤 같은 후보 — 이미 기록돼 있음
  assert.equal(pushes.length, 1);
});

test('본인 알림이 실패해도(토큰 조회 오류 · Expo 장애) MISSED 기록은 그대로 성공', async () => {
  const a = setup([missed(1)]);
  a.db.rows('push_tokens').push({ user_id: 'user-1', token: T1 });
  a.db.failOn = [{ table: 'push_tokens', op: 'select' }];
  assert.deepEqual(await quiet(() => runWakeCheck(a.service, NOW, { push: a.push })), { checked: 1, recorded: 1, pushed: 0, claimed: 0, nudged: 0 });
  assert.equal(a.db.rows('alarm_events').length, 1);

  const b = setup([missed(1)]);
  b.db.rows('push_tokens').push({ user_id: 'user-1', token: T1 });
  const down = { fetchImpl: async () => new Response('x', { status: 503 }), sleep: async () => {} };
  assert.deepEqual(await quiet(() => runWakeCheck(b.service, NOW, { push: down })), { checked: 1, recorded: 1, pushed: 0, claimed: 0, nudged: 0 });
});

test('토큰이 없는 본인에게는 푸시 없이 0', async () => {
  const { service, pushes, push } = setup([missed(1)]);
  assert.deepEqual(await runWakeCheck(service, NOW, { push }), { checked: 1, recorded: 1, pushed: 0, claimed: 0, nudged: 0 });
  assert.deepEqual(pushes, []);
});

// ---- 친구 알림 ('깨워 볼까요?' · 후속 '일어났어요') ----

const GROUP = '55555555-5555-4555-8555-555555555555';
const nudge = (recipient: string, over: Partial<NudgeRow> = {}): NudgeRow => ({ event_key: `NUDGE:s:2026-10-16:${recipient}`, kind: 'NUDGE', recipient_id: recipient, sleeper_id: 'sleeper', group_id: GROUP, ...over });

function nudgeSetup(nudges: NudgeRow[]) {
  const s = setup([], nudges);
  s.db.rows('profiles').push({ user_id: 'sleeper', nickname: '지형' }, { user_id: 'v1', nickname: '수연' });
  s.db.rows('push_tokens').push({ user_id: 'v1', token: T1 }, { user_id: 'v1', token: T2 }, { user_id: 'v2', token: T3 }, { user_id: 'sleeper', token: 'ExponentPushToken[dddddddddddddddddddddd]' });
  return s;
}

test('8-22: DB가 정한 받는 사람에게 "깨워 볼까요? / ○○님이 아직 안 일어났어요" — 안 일어난 사람 이름만 문구에, 눌러 열 그룹 · 사람이 알림 데이터에, 친구 채널', async () => {
  const { db, service, pushes, push } = nudgeSetup([nudge('v1'), nudge('v2')]);
  const result = await runWakeCheck(service, NOW, { push });

  assert.deepEqual(result, { checked: 0, recorded: 0, pushed: 0, claimed: 2, nudged: 3 });
  assert.deepEqual(db.rpcCalls.find((c) => c.name === 'claim_wake_nudges'), { name: 'claim_wake_nudges', args: { p_now: NOW.toISOString() } });
  assert.deepEqual(pushes.map((p) => p.to).sort(), [T1, T2, T3]);                                       // 받는 사람 기기만 — 안 일어난 사람 본인 기기에는 안 감
  assert.ok(pushes.every((p) => p.title === '깨워 볼까요?' && p.body === '지형님이 아직 안 일어났어요' && p.channelId === 'friend_v1'));
  assert.ok(pushes.every((p) => p.data.kind === 'WAKE_NUDGE' && p.data.path === '/group' && p.data.groupId === GROUP && p.data.subjectUserId === 'sleeper'));
  assert.deepEqual(pushes.filter((p) => p.to === T3).map((p) => p.data.recipientUserId), ['v2']);       // 받는 사람 id는 기기 주인
  assert.deepEqual([...new Set(db.rows('push_tickets').map((t) => t.kind))], ['WAKE_NUDGE']);
  assert.deepEqual(db.rows('push_tickets').map((t) => [t.token, t.user_id]).sort(), [[T1, 'v1'], [T2, 'v1'], [T3, 'v2']]);        // 영수증 표의 주인 = 받는 사람
});

test('8-22(많은 사람): 받는 사람 · 안 일어난 사람이 100명을 넘어도 프로필 · 토큰 조회를 100개씩 나눠 하고 모두에게 보냄 — 이름은 사람마다 맞게', async () => {
  const rows = Array.from({ length: 130 }, (_v, i) => nudge(`r${i}`, { sleeper_id: `s${i}`, event_key: `NUDGE:s${i}:2026-10-16:r${i}` }));
  const s = setup([], rows);
  for (let i = 0; i < 130; i++) {
    s.db.rows('profiles').push({ user_id: `s${i}`, nickname: `이름${i}` });
    s.db.rows('push_tokens').push({ user_id: `r${i}`, token: `ExponentPushToken[${String(i).padStart(22, '0')}]` });
  }
  const result = await runWakeCheck(s.service, NOW, { push: s.push });
  assert.deepEqual([result.claimed, result.nudged], [130, 130]);
  assert.equal(s.db.calls.filter((c) => c === 'select profiles').length, 2);
  assert.equal(s.db.calls.filter((c) => c === 'select push_tokens').length, 2);
  assert.equal(s.pushes.find((p) => p.data.recipientUserId === 'r125')?.body, '이름125님이 아직 안 일어났어요');
});

test('8-30: 후속은 "일어났어요 / ○○님이 일어났어요", 종류 WAKE_NUDGE_UP — 같은 배치에 둘이 섞여도 각자 문구', async () => {
  const { pushes, service, push, db } = nudgeSetup([nudge('v1'), nudge('v2', { kind: 'UP', event_key: 'UP:s:2026-10-16:v2' })]);
  const result = await runWakeCheck(service, NOW, { push });

  assert.equal(result.nudged, 3);
  const up = pushes.filter((p) => p.data.kind === 'WAKE_NUDGE_UP');
  assert.deepEqual(up.map((p) => [p.to, p.title, p.body, p.channelId, p.data.path, p.data.subjectUserId]), [[T3, '일어났어요', '지형님이 일어났어요', 'friend_v1', '/group', 'sleeper']]);
  assert.equal(pushes.filter((p) => p.data.kind === 'WAKE_NUDGE').length, 2);
  assert.deepEqual(db.rows('push_tickets').map((t) => t.kind).sort(), ['WAKE_NUDGE', 'WAKE_NUDGE', 'WAKE_NUDGE_UP']);
});

test('8-22(빈 목록): 받을 사람이 없으면(DB가 빈 목록) 푸시도 토큰 조회도 없음', async () => {
  const { db, service, pushes, push } = nudgeSetup([]);
  assert.equal((await runWakeCheck(service, NOW, { push })).nudged, 0);
  assert.deepEqual(pushes, []);
  assert.ok(!db.calls.includes('select push_tokens'));
});

test('받는 사람에게 토큰이 없으면 보낸 수 0, 이름이 비어 있으면 문구는 친구', async () => {
  const none = nudgeSetup([nudge('nobody')]);
  assert.equal((await runWakeCheck(none.service, NOW, { push: none.push })).nudged, 0);
  assert.deepEqual(none.pushes, []);

  const nameless = nudgeSetup([nudge('v1', { sleeper_id: 'ghost' })]);
  await runWakeCheck(nameless.service, NOW, { push: nameless.push });
  assert.ok(nameless.pushes.every((p) => p.body === '친구님이 아직 안 일어났어요'));
});

test('친구 알림 보내기가 실패해도(프로필 조회 오류 · Expo 장애) 배치는 성공 — DB는 이미 보낸 것으로 남겨서 다시 안 보냄', async () => {
  const a = nudgeSetup([nudge('v1')]);
  a.db.failOn = [{ table: 'profiles', op: 'select' }];
  assert.deepEqual(await quiet(() => runWakeCheck(a.service, NOW, { push: a.push })), { checked: 0, recorded: 0, pushed: 0, claimed: 1, nudged: 0 });

  const b = nudgeSetup([nudge('v1')]);
  const down = { fetchImpl: async () => new Response('x', { status: 503 }), sleep: async () => {} };
  assert.deepEqual(await quiet(() => runWakeCheck(b.service, NOW, { push: down })), { checked: 0, recorded: 0, pushed: 0, claimed: 1, nudged: 0 });
});

test('8-20(많은 사람): 한꺼번에 미확인이 된 사람이 100명을 넘어도 본인 알림의 토큰 조회를 100개씩 나눠 하고 모두에게 보냄', async () => {
  const rows = Array.from({ length: 130 }, (_v, i) => missed(i, { user_id: `user-${i}`, alarm_id: `alarm-${i}`, event_key: `key-${i}` }));
  const s = setup(rows);
  for (let i = 0; i < 130; i++) s.db.rows('push_tokens').push({ user_id: `user-${i}`, token: `ExponentPushToken[${String(i).padStart(22, '0')}]` });
  const result = await runWakeCheck(s.service, NOW, { push: s.push });
  assert.deepEqual([result.recorded, result.pushed], [130, 130]);
  assert.equal(s.db.calls.filter((c) => c === 'select push_tokens').length, 2);
});
