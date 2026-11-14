// 기기 전용 키(#515) — 발급 · 다시 발급 · 폐기 · 만료 · 다른 사용자 차단 (briefing-device.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVICE_KEY_TTL_MS, deviceTokenHash, deviceUser, issueDeviceKey, revokeDeviceKey } from './briefing-device.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-14T00:00:00Z');
const req = (token?: string) => new Request('http://x/alarm-briefing-device', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
const rejects = (p: Promise<unknown>) => assert.rejects(p, (e) => e instanceof HttpError && e.code === 'AUTH_REQUIRED');

test('발급한 키로 그 사용자를 알아냄 · 서버에는 해시만 · 30일 만료', async () => {
  const db = new FakeDb();
  const { token, expires_at } = await issueDeviceKey(db as never, A, PHONE, NOW);
  assert.match(token, /^bdk_[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(expires_at), NOW + DEVICE_KEY_TTL_MS);
  const [row] = db.rows('briefing_devices');
  assert.equal(row.token_hash, await deviceTokenHash(token));
  assert.ok(!JSON.stringify(db.rows('briefing_devices')).includes(token.slice(4)));
  assert.equal(await deviceUser(db as never, req(token), NOW + 1000), A);
  assert.equal(row.last_used_at, new Date(NOW + 1000).toISOString());
});

test('키 없음 · 모양 틀림 · 지어낸 키 · 만료 · 폐기 · 다시 발급한 뒤의 예전 키는 거절', async () => {
  const db = new FakeDb();
  await rejects(deviceUser(db as never, req(), NOW));
  await rejects(deviceUser(db as never, req('eyJhbGciOi.jwt.like'), NOW)); // 로그인 토큰(JWT)으로는 이 길을 못 씀
  await rejects(deviceUser(db as never, req(`bdk_${'a'.repeat(43)}`), NOW));

  const first = await issueDeviceKey(db as never, A, PHONE, NOW);
  await rejects(deviceUser(db as never, req(first.token), NOW + DEVICE_KEY_TTL_MS)); // 만료
  const second = await issueDeviceKey(db as never, A, PHONE, NOW); // 다시 발급 — 같은 줄의 해시만 바뀜
  assert.equal(db.rows('briefing_devices').length, 1);
  await rejects(deviceUser(db as never, req(first.token), NOW));
  assert.equal(await deviceUser(db as never, req(second.token), NOW), A);

  await revokeDeviceKey(db as never, A, PHONE); // 로그아웃
  await rejects(deviceUser(db as never, req(second.token), NOW));
});

test('같은 폰에서 다른 계정으로 로그인 — 키는 계정마다 따로, 남의 기기 줄은 못 지움 · 만료된 줄은 다음 발급 때 치움', async () => {
  const db = new FakeDb();
  const a = await issueDeviceKey(db as never, A, PHONE, NOW);
  const b = await issueDeviceKey(db as never, B, PHONE, NOW);
  assert.equal(await deviceUser(db as never, req(a.token), NOW), A);
  assert.equal(await deviceUser(db as never, req(b.token), NOW), B);
  await revokeDeviceKey(db as never, B, PHONE); // B가 같은 device_id로 지워도 A 줄은 남음
  assert.equal(await deviceUser(db as never, req(a.token), NOW), A);

  await issueDeviceKey(db as never, A, '44444444-4444-4444-8444-444444444444', NOW + DEVICE_KEY_TTL_MS + 1);
  assert.deepEqual(db.rows('briefing_devices').map((r) => r.device_id), ['44444444-4444-4444-8444-444444444444']);
  await assert.rejects(issueDeviceKey(db as never, A, 'not-a-uuid', NOW), (e) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
});
