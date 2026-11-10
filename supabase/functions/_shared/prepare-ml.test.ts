import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedMlProfile, buildMlRequest, calendarFeatures, mayUseMl, previousDateKey, requestMlPrediction, validMlEndpoint } from './prepare-ml.ts';

const profile = { ml_codes_verified: true, ml_age_code: '2' };
const at = new Date('2026-11-09T01:00:00Z');

test('uses appointment local date and previous day', () => {
  assert.deepEqual(calendarFeatures(at, 'Asia/Seoul'), {
    weekday_code: '1', '평토일구분코드': '1', '휴일종류코드': '__MISSING__',
  });
  assert.equal(previousDateKey(new Date('2026-12-01T01:00:00Z'), 'Asia/Seoul'), '2026-11-30');
});

test('unverified or absent demographics cannot trigger ML', () => {
  assert.equal(buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile: {}, previousDayMinutes: null }), null);
  assert.equal(buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile: { ...profile, ml_age_code: null }, previousDayMinutes: null }), null);
});

test('cold uses C1; consecutive-day warm uses W4', () => {
  const cold = buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile, previousDayMinutes: null });
  assert.equal(cold?.model, 'c1_mae');
  assert.deepEqual(Object.keys(cold!.features).sort(), [
    'weekday_code', '평토일구분코드', '휴일종류코드', '연령코드',
  ].sort());
  const warm = buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile, previousDayMinutes: 87 });
  assert.equal(warm?.model, 'w4_mae');
  assert.equal(warm?.features.previous_day_target_minutes, 87);
  assert.deepEqual(Object.keys(warm!.features).sort(), [
    'weekday_code', '평토일구분코드', '휴일종류코드', '연령코드', 'previous_day_target_minutes',
  ].sort());
  assert.equal(buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile, previousDayMinutes: 400 })?.model, 'c1_mae');
});

test('rejects remote plain HTTP; disabled flag prevents fetch', async () => {
  assert.equal(validMlEndpoint('http://remote.example.com'), false);
  assert.equal(validMlEndpoint('https://remote.example.com'), true);
  const request = buildMlRequest({ appointmentAt: at, timezone: 'Asia/Seoul', profile, previousDayMinutes: null })!;
  let calls = 0;
  const fakeFetch = async (_url: string, _init: RequestInit) => {
    calls++;
    return { ok: true, json: async () => ({ model: 'c1_mae', minutes: 71, prediction_type: 'point' }) };
  };
  const cfg = { enabled: true, url: 'https://remote.example.com', token: 'secret' };
  assert.equal(await requestMlPrediction(request, { ...cfg, enabled: false }, fakeFetch), null);
  assert.equal(calls, 0);
  assert.deepEqual(await requestMlPrediction(request, cfg, fakeFetch), { model: 'c1_mae', minutes: 71 });
  assert.equal(await requestMlPrediction(request, cfg, async () => { throw Error('offline'); }), null);
  assert.equal(await requestMlPrediction(request, cfg, async () => ({ ok: true, json: async () => ({ model: 'c1_mae', minutes: 999, prediction_type: 'point' }) })), null);
});

test('real ML is denied unless both flag and server-side UUID allowlist permit the user', () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const allowed = '11111111-1111-4111-8111-111111111111, ' + userId.toUpperCase();
  const base = { enabled: true, allowForPlan: true, userId };
  assert.equal(mayUseMl({ ...base, allowedUserIds: allowed }), true);
  assert.equal(mayUseMl({ ...base, enabled: false, allowedUserIds: allowed }), false);
  assert.equal(mayUseMl({ ...base, allowForPlan: false, allowedUserIds: allowed }), false);
  assert.equal(mayUseMl({ ...base, allowedUserIds: undefined }), false);
  assert.equal(mayUseMl({ ...base, allowedUserIds: '' }), false);
  assert.equal(mayUseMl({ ...base, allowedUserIds: 'not-a-uuid' }), false);
  assert.equal(mayUseMl({ ...base, userId: '11111111-1111-4111-8111-111111111111', allowedUserIds: userId }), false);
});

test('only a service-verified, consented and matching codebook profile can be used', () => {
  const good = {
    ml_age_code: '2',
    codebook_version: 'validated-v1',
    consent_at: '2025-01-01T00:00:00Z',
    verified_at: '2025-01-02T00:00:00Z',
  };
  assert.deepEqual(approvedMlProfile(good, 'validated-v1'), {
    ml_codes_verified: true, ml_age_code: '2',
  });
  assert.equal(approvedMlProfile(good, ''), null);
  assert.equal(approvedMlProfile(good, 'other-version'), null);
  assert.equal(approvedMlProfile({ ...good, consent_at: null }, 'validated-v1'), null);
  assert.equal(approvedMlProfile({ ...good, verified_at: null }, 'validated-v1'), null);
  assert.equal(approvedMlProfile({ ...good, ml_age_code: '__MISSING__' }, 'validated-v1'), null);
  assert.equal(approvedMlProfile({ ...good, ml_age_code: '9' }, 'validated-v1'), null);
  assert.equal(approvedMlProfile({ ...good, ml_age_code: '0' }, 'validated-v1'), null);
  assert.equal(approvedMlProfile({ ...good, consent_at: '3025-01-01T00:00:00Z' }, 'validated-v1'), null);
});
