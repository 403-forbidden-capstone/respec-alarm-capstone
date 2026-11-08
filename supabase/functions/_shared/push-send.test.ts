// 11장: 메시지별 문구 · 채널, 접수 번호(ticket), 다시 보내기, 영수증 가져오기 (push.ts의 새 부분 — 기존 시험은 push.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXPO_RECEIPTS_URL, fetchExpoReceipts, sendExpoMessages } from './push.ts';

const T1 = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const T2 = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const noSleep = async () => {};

test('sendExpoMessages: 메시지마다 제목 · 본문 · 데이터 · 채널을 따로 싣고 접수 번호를 토큰과 짝지어 돌려줌', async () => {
  let body: { to: string; title: string; body: string; channelId?: string; data: Record<string, unknown>; sound: string; priority: string }[] = [];
  const result = await sendExpoMessages(
    [
      { to: T1, title: 'A', body: 'a', channelId: 'group_v1', data: { recipientUserId: 'u1' } },
      { to: T2, title: 'B', body: 'b', data: { recipientUserId: 'u2' } },
    ],
    {
      sleep: noSleep,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ data: [{ status: 'ok', id: 't-1' }, { status: 'ok', id: 't-2' }] }));
      },
    },
  );
  assert.deepEqual(result, { sent: 2, failed: 0, invalidTokens: [], tickets: [{ token: T1, ticketId: 't-1' }, { token: T2, ticketId: 't-2' }] });
  assert.deepEqual(body[0], { to: T1, title: 'A', body: 'a', channelId: 'group_v1', data: { recipientUserId: 'u1' }, sound: 'default', priority: 'high' });
  assert.ok(!('channelId' in body[1])); // 채널을 안 정한 메시지는 필드 없음
});

test('sendExpoMessages: 네트워크 오류 · 5xx는 한 번 다시 보내고(처음 + 1), 401 · 403은 다시 보내지 않음, 횟수는 바꿀 수 있음', async () => {
  let n = 0;
  const flaky = await sendExpoMessages([{ to: T1, title: 't', body: 'b' }], {
    sleep: noSleep,
    fetchImpl: async () => {
      n += 1;
      if (n === 1) throw new Error('network down');
      return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'x' }] }));
    },
  });
  assert.equal(n, 2);
  assert.equal(flaky.sent, 1);

  let m = 0;
  const denied = await sendExpoMessages([{ to: T1, title: 't', body: 'b' }], { sleep: noSleep, fetchImpl: async () => { m += 1; return new Response('{}', { status: 401 }); } });
  assert.equal(m, 1);
  assert.equal(denied.reason, 'PUSH_NOT_CONFIGURED');

  let k = 0;
  const down = await sendExpoMessages([{ to: T1, title: 't', body: 'b' }], { sleep: noSleep, retries: 2, fetchImpl: async () => { k += 1; return new Response('{}', { status: 503 }); } });
  assert.equal(k, 3);
  assert.deepEqual([down.sent, down.failed, down.reason], [0, 1, 'PUSH_UNAVAILABLE']);

  let none = 0;
  await sendExpoMessages([{ to: T1, title: 't', body: 'b' }], { sleep: noSleep, retries: 0, fetchImpl: async () => { none += 1; return new Response('{}', { status: 503 }); } });
  assert.equal(none, 1);
});

test('sendExpoMessages: 다시 보내기 사이에 쉬는 시간을 둠 (처음 실패 뒤 한 번)', async () => {
  const waits: number[] = [];
  await sendExpoMessages([{ to: T1, title: 't', body: 'b' }], { sleep: async (ms) => { waits.push(ms); }, fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 2000);
});

test('sendExpoMessages: 접수 단계에서 DeviceNotRegistered인 토큰은 invalidTokens, 접수 번호는 성공한 것만, Expo 토큰 모양이 아닌 것은 보내지 않고 실패로 셈', async () => {
  const result = await sendExpoMessages([{ to: T1, title: 't', body: 'b' }, { to: T2, title: 't', body: 'b' }, { to: 'garbage', title: 't', body: 'b' }], {
    sleep: noSleep,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 't-1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] })),
  });
  assert.deepEqual(result.invalidTokens, [T2]);
  assert.deepEqual(result.tickets, [{ token: T1, ticketId: 't-1' }]);
  assert.deepEqual([result.sent, result.failed], [1, 2]);
});

test('fetchExpoReceipts: 접수 번호를 getReceipts에 묶어 보내고 영수증 표를 돌려줌 (300개씩, 응답 없는 번호는 아직 준비 안 됨)', async () => {
  const calls: { url: string; ids: string[] }[] = [];
  const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
  const out = await fetchExpoReceipts(ids, {
    accessToken: 'EXPO_TOKEN',
    fetchImpl: async (url, init) => {
      const sent = (JSON.parse(init?.body as string) as { ids: string[] }).ids;
      calls.push({ url, ids: sent });
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer EXPO_TOKEN');
      return new Response(JSON.stringify({ data: Object.fromEntries(sent.filter((id) => id !== 'id-7').map((id) => [id, id === 'id-3' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }])) }));
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((c) => [c.url, c.ids.length]), [[EXPO_RECEIPTS_URL, 300], [EXPO_RECEIPTS_URL, 150]]);
  assert.equal(Object.keys(out.receipts).length, 449);
  assert.equal(out.receipts['id-3'].status, 'error');
  assert.ok(!('id-7' in out.receipts));
});

test('fetchExpoReceipts: 요청이 실패하면 ok:false (영수증을 못 받은 것이지 만료가 아님), 번호가 없으면 부르지 않음', async () => {
  assert.deepEqual(await fetchExpoReceipts(['a'], { fetchImpl: async () => new Response('{}', { status: 500 }) }), { ok: false, receipts: {} });
  assert.equal((await fetchExpoReceipts(['a'], { fetchImpl: async () => { throw new Error('x'); } })).ok, false);
  assert.deepEqual(await fetchExpoReceipts([], { fetchImpl: async () => { throw new Error('호출하면 안 됨'); } }), { ok: true, receipts: {} });
});
