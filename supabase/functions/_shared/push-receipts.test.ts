// 푸시 영수증 확인 (친구 논리설계 11장, 시험 11-06 · 11-07) — 15분 뒤 확인해 앱이 지워진 기기의 토큰을 지우고 표를 정리
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDb } from './fake-db.ts';
import { RECEIPT_DELAY_MS, runReceiptCheck, TICKET_MAX_AGE_MS } from './push-receipts.ts';
import type { Db } from './supabase.ts';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TA = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TB = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const TC = 'ExponentPushToken[cccccccccccccccccccccc]';

function setup() {
  const db = new FakeDb();
  db.rows('push_tokens').push({ user_id: A, token: TA }, { user_id: B, token: TB }, { user_id: B, token: TC });
  return { db, service: db as unknown as Db };
}
const receiptsOf = (map: Record<string, unknown>) => async (_url: string, init?: RequestInit) => {
  const ids = (JSON.parse(init?.body as string) as { ids: string[] }).ids;
  return new Response(JSON.stringify({ data: Object.fromEntries(ids.filter((id) => id in map).map((id) => [id, map[id]])) }));
};
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

test('15분 지난 접수 번호만 확인함 — 더 최근 것은 그대로 두고, 확인한 줄은 표에서 지움 (11-07)', async () => {
  const { db, service } = setup();
  db.rows('push_tickets').push(
    { ticket_id: 'old', user_id: A, token: TA, kind: 'WAKE_PING', created_at: ago(RECEIPT_DELAY_MS + 1000) },
    { ticket_id: 'fresh', user_id: B, token: TB, kind: 'WAKE_PING', created_at: ago(RECEIPT_DELAY_MS - 60_000) },
  );
  const asked: string[] = [];
  const result = await runReceiptCheck(service, NOW, {
    fetchImpl: async (u, i) => {
      asked.push(...(JSON.parse(i?.body as string) as { ids: string[] }).ids);
      return receiptsOf({ old: { status: 'ok' }, fresh: { status: 'ok' } })(u, i);
    },
  });
  assert.deepEqual(asked, ['old']);
  assert.deepEqual(result, { checked: 1, tokensRemoved: 0, expired: 0 });
  assert.deepEqual(db.rows('push_tickets').map((t) => t.ticket_id), ['fresh']);
  assert.equal(db.rows('push_tokens').length, 3);
});

test('11-06: 영수증이 DeviceNotRegistered면 그 토큰을 push_tokens에서 지움 (다른 오류는 토큰을 건드리지 않고, 같은 사람의 다른 폰도 그대로)', async () => {
  const { db, service } = setup();
  db.rows('push_tickets').push(
    { ticket_id: 't-a', user_id: A, token: TA, kind: 'FRIEND_REQUEST', created_at: ago(RECEIPT_DELAY_MS + 1000) },
    { ticket_id: 't-b', user_id: B, token: TB, kind: 'FRIEND_REQUEST', created_at: ago(RECEIPT_DELAY_MS + 1000) },
    { ticket_id: 't-c', user_id: B, token: TC, kind: 'FRIEND_REQUEST', created_at: ago(RECEIPT_DELAY_MS + 1000) },
  );
  const result = await runReceiptCheck(service, NOW, {
    fetchImpl: receiptsOf({ 't-a': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }, 't-b': { status: 'ok' }, 't-c': { status: 'error', message: 'big', details: { error: 'MessageTooBig' } } }),
  });
  assert.deepEqual(result, { checked: 3, tokensRemoved: 1, expired: 0 });
  assert.deepEqual(db.rows('push_tokens').map((t) => t.token).sort(), [TB, TC]); // 앱을 지운 기기(A)만 사라짐
  assert.equal(db.rows('push_tickets').length, 0);
});

test('영수증이 아직 없으면(Expo가 준비 전) 줄을 남겨 다음 배치에 다시 확인하고, 24시간이 지나도 없으면 포기하고 지움', async () => {
  const { db, service } = setup();
  db.rows('push_tickets').push(
    { ticket_id: 'wait', user_id: A, token: TA, kind: 'WAKE_PING', created_at: ago(RECEIPT_DELAY_MS + 1000) },
    { ticket_id: 'give-up', user_id: B, token: TB, kind: 'WAKE_PING', created_at: ago(TICKET_MAX_AGE_MS + 1000) },
  );
  const result = await runReceiptCheck(service, NOW, { fetchImpl: receiptsOf({}) });
  assert.deepEqual(result, { checked: 2, tokensRemoved: 0, expired: 1 });
  assert.deepEqual(db.rows('push_tickets').map((t) => t.ticket_id), ['wait']);
  assert.equal(db.rows('push_tokens').length, 3);
});

test('Expo 영수증 요청이 실패하면 아무것도 지우지 않고 다음 배치로 미룸 (오류로 던지지 않음)', async () => {
  const { db, service } = setup();
  db.rows('push_tickets').push({ ticket_id: 'x', user_id: A, token: TA, kind: 'WAKE_PING', created_at: ago(RECEIPT_DELAY_MS + 1000) });
  const result = await runReceiptCheck(service, NOW, { fetchImpl: async () => new Response('{}', { status: 503 }) });
  assert.deepEqual(result, { checked: 0, tokensRemoved: 0, expired: 0 });
  assert.equal(db.rows('push_tickets').length, 1);
  assert.equal(db.rows('push_tokens').length, 3);
});

test('확인할 줄이 없으면 Expo를 부르지 않음', async () => {
  const { service } = setup();
  const result = await runReceiptCheck(service, NOW, { fetchImpl: async () => { throw new Error('호출하면 안 됨'); } });
  assert.deepEqual(result, { checked: 0, tokensRemoved: 0, expired: 0 });
});

test('DB 읽기가 실패해도 던지지 않고 로그만 (MISSED 기록과 같은 배치라 서로 안 막음)', async () => {
  const { db, service } = setup();
  db.rows('push_tickets').push({ ticket_id: 'x', user_id: A, token: TA, kind: 'WAKE_PING', created_at: ago(RECEIPT_DELAY_MS + 1000) });
  db.failOn.push({ table: 'push_tickets', op: 'select' });
  const result = await quiet(() => runReceiptCheck(service, NOW, { fetchImpl: receiptsOf({ x: { status: 'ok' } }) }));
  assert.deepEqual(result, { checked: 0, tokensRemoved: 0, expired: 0 });
});
