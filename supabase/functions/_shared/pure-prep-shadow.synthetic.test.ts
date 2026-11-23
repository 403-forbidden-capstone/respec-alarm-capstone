// Synthetic smoke test: 15 fictional outings, no Supabase writes or real identities.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmedPurePrepHistory, choosePurePrepBasis,
  type PrepCompletionRow,
} from './calc/pure-prep-basis.ts';
import {
  buildPurePrepShadowRequest, requestPurePrepShadow,
} from './pure-prep-shadow.ts';

const durations = [20, 19, 23, 25, 21, 22, 18, 26, 24, 20, 25, 22, 24, 27, 19];
const cutoff = new Date('2026-11-23T00:00:00.000Z');
const appointmentAt = new Date('2026-11-25T01:00:00.000Z');
const base = {
  appointmentAt, timezone: 'Asia/Seoul',
  verifiedAgeCode: '2', verifiedHolidayCode: null,
};
function fixture(minutes: number, day: number): PrepCompletionRow {
  const departure = new Date(Date.parse('2026-11-01T08:00:00.000Z') + day * 86400000);
  return {
    prepare_started_at: new Date(departure.getTime() - minutes * 60000).toISOString(),
    departed_at: departure.toISOString(),
    prepare_started_source: 'PREPARE_ALARM',
    departed_source: 'LOCATION',
  };
}
const sessions = durations.map((minutes, day) => fixture(minutes, day));

test('fictional 0/2/3/9/10/15 records retain the existing PROFILE/HISTORY schedule', async () => {
  for (const n of [0, 2, 3, 9, 10, 15]) {
    const valid = confirmedPurePrepHistory(sessions.slice(0, n), cutoff);
    assert.equal(valid.length, n);
    const basis = choosePurePrepBasis({ profileMinutes: 15, historicalMinutes: valid });
    assert.equal(basis?.source, n >= 3 ? 'HISTORY' : 'PROFILE');
    assert.equal(basis?.minutes, n < 3 ? 15 : Math.round(valid.reduce((a,b)=>a+b,0)/n));
    const request = buildPurePrepShadowRequest({ ...base, historyMinutes: valid });
    assert.equal(request !== null, n >= 10);
    if (n >= 10) {
      assert.equal(request?.history_count, n);
      assert.equal(request?.model, 'prep_start_ratio_v2');
      assert.equal(request?.features.baseline_observed, valid.reduce((a,b)=>a+b,0)/n);
    }
  }
});

test('nine genuine records plus invalid, duplicate and future events never reaches ten', () => {
  const goodNine = sessions.slice(0,9);
  const other = [
    fixture(9, 17),   // Too short.
    fixture(241, 18), // Too long.
    { ...fixture(20, 19), prepare_started_source: 'ROUTINE_STEP' },
    { ...fixture(20, 20), departed_source: 'MANUAL' },
    { ...fixture(20, 21), departed_at: null },
    fixture(22, 31),  // After prediction cutoff.
    goodNine[0],      // Duplicate event.
  ];
  const valid = confirmedPurePrepHistory([...goodNine, ...other], cutoff);
  assert.equal(valid.length, 9);
  assert.equal(buildPurePrepShadowRequest({ ...base, historyMinutes: valid }), null);
});

test('mock model API is never called for nine, but only shadow-predicts at ten', async () => {
  const historyNine = confirmedPurePrepHistory(sessions.slice(0,9), cutoff);
  const historyTen = confirmedPurePrepHistory(sessions.slice(0,10), cutoff);
  const reqTen = buildPurePrepShadowRequest({...base,historyMinutes:historyTen})!;
  let calls = 0;
  const fakeFetch: typeof fetch = (async (_url: unknown, opts: any) => {
    calls++;
    const payload = JSON.parse(opts.body);
    assert.equal(payload.model, 'prep_start_ratio_v2');
    assert.equal(payload.history_count, 10);
    const baseline = payload.features.baseline_observed;
    return {
      ok: true,
      json: async () => ({
        model: 'prep_start_ratio_v2',
        prediction_type: 'ratio',
        training_target: 'survey_start_cluster_proxy',
        minutes: baseline * 1.05, ratio: 1.05,
      }),
    };
  }) as any;
  const config = {url:'https://example.org',token:'synthetic-do-not-use',allowSurveyProxy:true};
  const blocked = buildPurePrepShadowRequest({...base,historyMinutes:historyNine});
  assert.equal(blocked,null);
  assert.equal(await requestPurePrepShadow({...reqTen,history_count:9},config,fakeFetch),null);
  assert.equal(calls,0);
  const before = choosePurePrepBasis({profileMinutes:15,historicalMinutes:historyTen});
  const output = await requestPurePrepShadow(reqTen,config,fakeFetch);
  const after = choosePurePrepBasis({profileMinutes:15,historicalMinutes:historyTen});
  assert.equal(calls,1);
  assert.equal(output?.model,'prep_start_ratio_v2');
  assert.equal(output?.training_target,'survey_start_cluster_proxy');
  assert.deepEqual(after,before); // The research model never changes the alarm.
  assert.equal(after?.source,'HISTORY');
  assert.equal(await requestPurePrepShadow(reqTen,{...config,allowSurveyProxy:false},fakeFetch),null);
});
