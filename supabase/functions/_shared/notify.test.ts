// notify 본문 — 권한 거절 · 허용, 알람 id 확인, 토큰 없음, 만료 토큰 삭제를 가짜 DB(rpc 포함)와 가짜 Expo 서버로
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import { readNotifyRequest, runNotify, type NotifyRequest } from './notify.ts';
import { Reader } from './read.ts';
import type { Db } from './supabase.ts';

const SENDER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ALARM = '44444444-4444-4444-8444-444444444444';
const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

const request = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({ kind: 'ALARM_CHANGED', targetUserId: TARGET, title: '알람이 바뀌었어요', body: '수연님이 기상 알람을 5분 앞당겼어요', ...over });

// can_send_push는 DB 함수라 여기서는 "ALARM_CHANGED만 SENDER → TARGET 허용"으로 흉내 (WAKE_PING은 D19 전이라 늘 거절)
function setup() {
  const db = new FakeDb();
  db.rpcHandlers.can_send_push = (a) => a.p_kind === 'ALARM_CHANGED' && a.p_sender_id === SENDER && a.p_target_id === TARGET;
  db.rows('alarms').push({ alarm_id: ALARM, user_id: TARGET });
  db.rows('push_tokens').push({ user_id: TARGET, token: T1 }, { user_id: TARGET, token: T2 }, { user_id: OTHER, token: 'ExponentPushToken[cccccccccccccccccccccc]' });
  const pushes: { to: string; data: Record<string, unknown> }[] = [];
  const fetchImpl = (tickets: (to: string) => unknown) => async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { to: string; data: Record<string, unknown> }[];
    pushes.push(...body.map((b) => ({ to: b.to, data: b.data })));
    return new Response(JSON.stringify({ data: body.map((b) => tickets(b.to)) }));
  };
  return { db, service: db as unknown as Db, pushes, fetchImpl };
}
const okAll = () => ({ status: 'ok', id: 'x' });

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

test('권한이 있으면 받는 사람의 토큰 전부에 보냄 (다른 사람 토큰은 안 건드림), can_send_push 인자 이름', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  const result = await runNotify(service, SENDER, request({ alarmId: ALARM, data: { screen: 'H03' } }), { fetchImpl: fetchImpl(okAll) });

  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(db.rpcCalls, [{ name: 'can_send_push', args: { p_sender_id: SENDER, p_target_id: TARGET, p_kind: 'ALARM_CHANGED' } }]);
  assert.deepEqual(pushes.map((p) => p.to).sort(), [T1, T2]);
  assert.deepEqual(pushes[0].data, { screen: 'H03', kind: 'ALARM_CHANGED', alarmId: ALARM }); // 종류 · 알람 id는 서버가 덮어씀
});

test('권한이 없으면 403 — 토큰도 Expo도 건드리지 않음', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  await assert.rejects(
    () => runNotify(service, OTHER, request(), { fetchImpl: fetchImpl(okAll) }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === 'FORBIDDEN' && e.message.includes('권한'),
  );
  assert.deepEqual(pushes, []);
  assert.ok(!db.calls.includes('select push_tokens'));
});

test('깨우기(WAKE_PING)는 D19 전이라 DB 함수가 거절하는 대로 403', async () => {
  const { service, pushes, fetchImpl } = setup();
  await assert.rejects(
    () => runNotify(service, SENDER, request({ kind: 'WAKE_PING' }), { fetchImpl: fetchImpl(okAll) }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && e.message.includes('깨우기'),
  );
  assert.deepEqual(pushes, []);
});

test('알람 id는 받는 사람의 알람이어야 함 (남의 알람 id로 알림을 꾸미지 못함)', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.rows('alarms').push({ alarm_id: '55555555-5555-4555-8555-555555555555', user_id: OTHER });
  await assert.rejects(
    () => runNotify(service, SENDER, request({ alarmId: '55555555-5555-4555-8555-555555555555' }), { fetchImpl: fetchImpl(okAll) }),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  assert.deepEqual(pushes, []);
});

test('받는 사람의 토큰이 없으면 오류가 아니라 { sent: 0, reason: NO_TOKENS }', async () => {
  const { db, service, pushes, fetchImpl } = setup();
  db.tables.push_tokens = [];
  assert.deepEqual(await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(okAll) }), { sent: 0, failed: 0, reason: 'NO_TOKENS' });
  assert.deepEqual(pushes, []);
});

test('만료된 토큰(DeviceNotRegistered)은 push_tokens에서 지움, 나머지는 보냄', async () => {
  const { db, service, fetchImpl } = setup();
  const tickets = (to: string) => (to === T2 ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : okAll());
  const result = await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(tickets) });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(db.rows('push_tokens').filter((t) => t.user_id === TARGET).map((t) => t.token), [T1]);
  assert.equal(db.rows('push_tokens').filter((t) => t.user_id === OTHER).length, 1); // 다른 사람 토큰은 그대로
});

test('푸시 설정이 아직 없으면(FCM 키 없음 · Expo 401) 오류가 아니라 reason을 돌려줌', async () => {
  const { service, fetchImpl } = setup();
  const noKey = await runNotify(service, SENDER, request(), { fetchImpl: fetchImpl(() => ({ status: 'error', message: 'no fcm', details: { error: 'InvalidCredentials' } })) });
  assert.deepEqual(noKey, { sent: 0, failed: 2, reason: 'PUSH_NOT_CONFIGURED' });
  const unauthorized = await runNotify(service, SENDER, request(), { accessToken: 'WRONG', fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.deepEqual(unauthorized, { sent: 0, failed: 2, reason: 'PUSH_NOT_CONFIGURED' });
  const down = await runNotify(service, SENDER, request(), { fetchImpl: async () => new Response('{}', { status: 503 }) });
  assert.equal(down.reason, 'PUSH_UNAVAILABLE');
});

test('권한 판정 DB 함수가 실패하면 일반 문구의 500 (원문은 안 보임)', async () => {
  const { db, service } = setup();
  db.rpcHandlers.can_send_push = () => {
    throw new Error('relation "secret_table" missing');
  };
  await quiet(() =>
    assert.rejects(
      () => runNotify(service, SENDER, request()),
      (e: unknown) => e instanceof HttpError && e.status === 500 && !e.message.includes('secret_table'),
    ),
  );
});

test('요청 읽기: 필수 칸 · 종류 · UUID · data 크기를 한 번에 알려 줌', () => {
  const ok = readNotifyRequest(Reader.root({ kind: 'ALARM_CHANGED', targetUserId: TARGET, alarmId: ALARM, title: ' 제목 ', body: '본문', data: { a: 1 } }));
  assert.deepEqual(ok, { kind: 'ALARM_CHANGED', targetUserId: TARGET, alarmId: ALARM, title: '제목', body: '본문', data: { a: 1 } });

  assert.throws(
    () => readNotifyRequest(Reader.root({ kind: 'SPAM', targetUserId: 'x', title: '', data: { big: 'x'.repeat(2_100) } })),
    (e: unknown) =>
      e instanceof HttpError &&
      e.status === 400 &&
      (e.details as { issues: { path: string }[] }).issues.map((i) => i.path).sort().join() === 'body,data,kind,targetUserId,title',
  );
});
