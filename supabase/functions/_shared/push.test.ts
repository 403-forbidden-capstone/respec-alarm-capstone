import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXPO_PUSH_URL, sendExpoPush } from './push.ts';

const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const message = { title: '알람이 바뀌었어요', body: '수연님이 기상 알람을 5분 앞당겼어요', data: { kind: 'ALARM_CHANGED', alarmId: 'a' } };

const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('Expo 서버에 메시지 배열을 보냄 (토큰별 한 건씩, 선택 액세스 토큰)', async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const result = await sendExpoPush([T1, T2], message, {
    accessToken: 'EXPO_TOKEN',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: [{ status: 'ok', id: '1' }, { status: 'ok', id: '2' }] }));
    },
  });
  assert.deepEqual(result, { sent: 2, failed: 0, invalidTokens: [] });
  assert.equal(seen?.url, EXPO_PUSH_URL);
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer EXPO_TOKEN');
  const body = JSON.parse(seen?.init?.body as string);
  assert.equal(body.length, 2);
  assert.deepEqual(body[0], { to: T1, title: message.title, body: message.body, data: message.data, sound: 'default', priority: 'high' });
});

test('액세스 토큰이 없으면 Authorization 머리글을 안 붙임', async () => {
  let headers: Record<string, string> = {};
  await sendExpoPush([T1], message, {
    fetchImpl: async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }));
    },
  });
  assert.equal('Authorization' in headers, false);
});

test('만료된 토큰(DeviceNotRegistered)은 지울 목록에', async () => {
  const result = await sendExpoPush([T1, T2], message, {
    fetchImpl: reply({ data: [{ status: 'ok' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
  });
  assert.deepEqual(result, { sent: 1, failed: 1, invalidTokens: [T2] });
});

test('FCM 키가 없으면(InvalidCredentials) 설정 안 됨으로', async () => {
  const result = await sendExpoPush([T1], message, {
    fetchImpl: reply({ data: [{ status: 'error', message: 'no fcm', details: { error: 'InvalidCredentials' } }] }),
  });
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'PUSH_NOT_CONFIGURED');
});

test('Expo 서버가 안 되면 PUSH_UNAVAILABLE (네트워크 오류 · 5xx)', async () => {
  const down = await sendExpoPush([T1], message, { fetchImpl: reply({ errors: [{ code: 'X' }] }, 503) });
  assert.deepEqual([down.sent, down.failed, down.reason], [0, 1, 'PUSH_UNAVAILABLE']);
  const offline = await sendExpoPush([T1], message, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(offline.reason, 'PUSH_UNAVAILABLE');
});

test('Expo 토큰 모양이 아닌 것은 보내지 않고 실패로만 셈, 100개씩 나눠 보냄', async () => {
  let calls = 0;
  const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${String(i).padStart(22, '0')}]`);
  const result = await sendExpoPush([...tokens, 'not-a-token'], message, {
    fetchImpl: async (_url, init) => {
      calls += 1;
      const n = JSON.parse(init?.body as string).length;
      return new Response(JSON.stringify({ data: Array.from({ length: n }, () => ({ status: 'ok' })) }));
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual([result.sent, result.failed], [150, 1]);
});

test('토큰이 없으면 호출 없이 0', async () => {
  const result = await sendExpoPush([], message, {
    fetchImpl: async () => {
      throw new Error('호출하면 안 됨');
    },
  });
  assert.deepEqual(result, { sent: 0, failed: 0, invalidTokens: [] });
});
