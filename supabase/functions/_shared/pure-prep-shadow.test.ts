import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PURE_PREP_SHADOW_MIN_HISTORY, buildPurePrepShadowRequest,
  eligibleForPurePrepShadow, requestPurePrepShadow,
} from './pure-prep-shadow.ts';

const at = new Date('2026-11-25T01:00:00Z');
const userId = '11111111-1111-4111-8111-111111111111';
const base = {
  appointmentAt: at, timezone: 'Asia/Seoul',
  verifiedAgeCode: '2', verifiedHolidayCode: null,
};
const history = Array.from({ length: 10 }, (_, i) => 25 + i);
test('10 complete past records, never 9, allow a v2 shadow request', () => {
  assert.equal(PURE_PREP_SHADOW_MIN_HISTORY, 10);
  assert.equal(buildPurePrepShadowRequest({ ...base, historyMinutes: history.slice(0, 9) }), null);
  const request = buildPurePrepShadowRequest({ ...base, historyMinutes: history });
  assert.equal(request?.model, 'prep_start_ratio_v2');
  assert.equal(request?.history_count, 10);
  assert.equal(request?.features.baseline_observed, 29.5);
  assert.equal(request?.features['휴일종류코드'], '__MISSING__');
  assert.equal(buildPurePrepShadowRequest({ ...base, verifiedAgeCode: null, historyMinutes: history }), null);
});
test('historical outliers do not qualify as valid history', () => {
  assert.equal(buildPurePrepShadowRequest({ ...base, historyMinutes: [...history.slice(0, 9), 500] }), null);
});
test('disabled, other user, nonconsented, group, legacy, and manual cases are fail-closed', () => {
  const eligible = {
    enabled: true, allowedUserIds: userId, userId,
    profileConsentedAt: '2026-11-22T00:00:00Z', personalAppointment: true,
    purePlan: true, manualOverride: false,
  };
  assert.equal(eligibleForPurePrepShadow(eligible), true);
  for (const override of [
    { enabled: false }, { allowedUserIds: '' },
    { userId: '22222222-2222-4222-8222-222222222222' },
    { profileConsentedAt: null }, { personalAppointment: false },
    { purePlan: false }, { manualOverride: true },
  ]) assert.equal(eligibleForPurePrepShadow({ ...eligible, ...override }), false);
});
test('shadow response checks model identity, versioned target, safety range, and no auth leaks', async () => {
  const request = buildPurePrepShadowRequest({ ...base, historyMinutes: history })!;
  let calls = 0;
  const fake = async (_url: any, options: any) => {
    calls++;
    assert.equal(options.headers['x-api-key'], 'test-token-not-for-production');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.history_count, 10);
    return {
      ok: true,
      json: async () => ({
        model: 'prep_start_ratio_v2', prediction_type: 'ratio',
        training_target: 'survey_start_cluster_proxy', minutes: 30, ratio: 30/29.5,
      }),
    };
  };
  const cfg = { url: 'https://model.example.org', token: 'test-token-not-for-production' };
  assert.equal(await requestPurePrepShadow({ ...request, history_count: 9 }, cfg, fake as any), null);
  assert.equal(calls, 0);
  assert.equal(await requestPurePrepShadow(request, cfg, fake as any), null); // proxy must explicitly opt in
  assert.equal(calls, 1);
  assert.deepEqual(await requestPurePrepShadow(request, { ...cfg, allowSurveyProxy: true }, fake as any), {
    model: 'prep_start_ratio_v2', minutes: 30, ratio: 30/29.5, training_target: 'survey_start_cluster_proxy',
  });
  assert.equal(await requestPurePrepShadow(request, { ...cfg, url: 'http://model.example.org' }, fake as any), null);
  assert.equal(calls, 2);
  const actual = async () => ({ ok: true, json: async () => ({
    model: 'prep_start_ratio_v2', prediction_type: 'ratio',
    training_target: 'actual_start_depart', minutes: 32, ratio: 32/29.5,
  }) });
  assert.equal((await requestPurePrepShadow(request, cfg, actual as any))?.training_target, 'actual_start_depart');
  assert.equal(await requestPurePrepShadow(request, cfg, async () => { throw Error('offline'); }), null);
});
