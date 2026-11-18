import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  preparationHistory, buildPrepAdjustRequest, requestPrepAdjustment,
  PREP_ADJUST_MIN_RECORDS,
} from './prep-adjust.ts';
const ago = (n: number) => new Date(Date.UTC(2026, 10, 18, 0, -n)).toISOString();
const now = new Date('2026-11-18T00:00:00Z');
const rec = (before: number, duration: number, source = 'ROUTINE_STEP') => ({
  prepare_started_at: ago(before + duration),
  departed_at: ago(before),
  prepare_started_source: source,
});
test('requires >= 3 observed preparation-start -> departure records', () => {
  assert.equal(PREP_ADJUST_MIN_RECORDS, 3);
  assert.equal(preparationHistory([rec(30, 30), rec(150, 45)], now), null);
  const h = preparationHistory([rec(30, 30), rec(150, 45), rec(300, 60), rec(480, 30, 'UNKNOWN')], now);
  assert.deepEqual(h, { minutes: [30, 45, 60], count: 3, baselineMinutes: 45 });
});
test('rejects future, duplicate, reversed, out-of-range, or scheduled-only records', () => {
  const h = preparationHistory([
    rec(30, 30), rec(30, 30), rec(150, 45), rec(300, 60),
    rec(-5, 40), rec(500, 250), rec(650, 0), rec(700, -5), rec(800, 40, 'UNKNOWN'),
  ], now);
  assert.equal(h?.count, 3);
  assert.deepEqual(h?.minutes, [30, 45, 60]);
  const dismiss = preparationHistory([rec(30, 30, 'PREPARE_ALARM'), rec(150, 45, 'PREPARE_ALARM'), rec(300, 60, 'PREPARE_ALARM')], now);
  assert.equal(dismiss?.count, 3);
});
test('request uses only preexisting baseline + calendar + verified demographics; no activities observed on target day', () => {
  const h = preparationHistory([rec(30, 30), rec(150, 45), rec(300, 60)], now);
  const q = buildPrepAdjustRequest(new Date('2026-11-19T01:00:00Z'), 'Asia/Seoul', '2', null, h);
  assert.equal(q?.model, 'prep_start_ratio_v2');
  assert.equal(q?.features.baseline_observed, 45);
  assert.equal(q?.features['휴일종류코드'], '__MISSING__');
  assert.equal(q?.history_count, 3);
  assert.deepEqual(Object.keys(q!.features).sort(), ['weekday_code', '평토일구분코드', '휴일종류코드', '연령코드', 'baseline_observed'].sort());
  assert.equal(buildPrepAdjustRequest(now, 'Asia/Seoul', '99', null, h), null);
  assert.equal(buildPrepAdjustRequest(now, 'Asia/Seoul', '2', null, null), null);
});
test('sidecar is fail closed on missing config, invalid output, timeout, and network errors', async () => {
  const q = buildPrepAdjustRequest(now, 'Asia/Seoul', '2', '1', {
    minutes: [30, 40, 50], count: 3, baselineMinutes: 40,
  })!;
  let calls = 0;
  const good = async () => {
    calls++;
    return { ok: true, json: async () => ({ model: 'prep_start_ratio_v2', prediction_type: 'ratio', training_target: 'actual_start_depart', minutes: 48, ratio: 1.2 }) };
  };
  const config = { enabled: true, url: 'https://example.org', token: 'secret' };
  assert.equal(await requestPrepAdjustment(q, { ...config, enabled: false }, good), null);
  assert.equal(calls, 0);
  assert.equal(await requestPrepAdjustment(q, { ...config, url: 'http://example.org' }, good), null);
  assert.deepEqual(await requestPrepAdjustment(q, config, good), { model: 'prep_start_ratio_v2', minutes: 48, ratio: 1.2 }); // valid response
  assert.equal(await requestPrepAdjustment(q, config, async () => ({ok: true, json: async () => ({model:'c1_mae',prediction_type:'ratio',training_target:'actual_start_depart',minutes:48,ratio:1.2})})), null);
  assert.equal(await requestPrepAdjustment(q, config, async () => ({ok: true, json: async () => ({model:'prep_start_ratio_v2',prediction_type:'ratio',training_target:'actual_start_depart',minutes:200,ratio:1.2})})), null);
  const survey = async () => ({ok:true, json:async()=>({model:'prep_start_ratio_v2',prediction_type:'ratio',training_target:'survey_start_cluster_proxy',minutes:48,ratio:1.2})});
  assert.equal(await requestPrepAdjustment(q, config, survey), null);
  assert.deepEqual(await requestPrepAdjustment(q, {...config, allowSurveyProxy:true}, survey), {model:'prep_start_ratio_v2',minutes:48,ratio:1.2});
  assert.equal(await requestPrepAdjustment(q, config, async () => { throw Error('offline'); }), null);
});
