// 예측 준비 시간 — 앱 목업 estimateAppointment의 "공통 P80 + 개인 보정"과 같은 숫자
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_COMMON_P80, percentile, predictPrepare, prepareSourceLabel, prepareStatsOf, toMorningMinutes } from './prepare.ts';

test('목업 시나리오(기상부터): 공통 50 · n 10 · k 10 · 개인 오차 P80 20 → 보정 10 → 예측 60', () => {
  const p = predictPrepare({ commonP80: 50, personalP80: 70, sampleCount: 10, prior: 10 });
  assert.deepEqual([p.commonP80, p.weight, p.residualP80, p.correction, p.minutes], [50, 0.5, 20, 10, 60]);
});

test('목업 시나리오(같은 날 앞선 일정이 있음): 공통 15 → 개인 오차 20이면 예측 25', () => {
  const p = predictPrepare({ commonP80: DEFAULT_COMMON_P80.sameDay, personalP80: 35, sampleCount: 10, prior: 10 });
  assert.equal(p.minutes, 25);
});

test('기록이 없으면 개인 보정 없이 공통 P80 그대로, 출처 DEFAULT · 신뢰 LOW', () => {
  const p = predictPrepare({ commonP80: 50, personalP80: null, sampleCount: 0 });
  assert.deepEqual([p.minutes, p.correction, p.source, p.confidence], [50, 0, 'DEFAULT', 'LOW']);
});

test('기록이 5건 이상이면 출처 PERSONAL, 15건 이상이면 신뢰 HIGH (7장 7.2.1 · 7.2.4)', () => {
  assert.equal(predictPrepare({ commonP80: 50, personalP80: 60, sampleCount: 5 }).source, 'PERSONAL');
  assert.equal(predictPrepare({ commonP80: 50, personalP80: 60, sampleCount: 5 }).confidence, 'MEDIUM');
  assert.equal(predictPrepare({ commonP80: 50, personalP80: 60, sampleCount: 15 }).confidence, 'HIGH');
});

test('직접 고른 값이 먼저 (자르지 않음), 자동 예측은 autoMinutes에 남김', () => {
  const p = predictPrepare({ commonP80: 50, personalP80: 70, sampleCount: 10, prior: 10, override: 5 });
  assert.deepEqual([p.minutes, p.autoMinutes, p.source], [5, 60, 'MANUAL']);
});

test('목업과 같게 보정 상한 · 예측 범위로 자르지 않음 (7장 7.0.5 ±30분 · 7.2.2 15~240분은 D56 뒤)', () => {
  // 목업: correction = round(n ÷ (n + k) × 개인 오차 P80), 예측 = 공통 P80 + correction
  const high = predictPrepare({ commonP80: 50, personalP80: 400, sampleCount: 1000, prior: 10 });
  assert.deepEqual([high.correction, high.minutes], [Math.round((1000 / 1010) * 350), 50 + Math.round((1000 / 1010) * 350)]);
  const low = predictPrepare({ commonP80: 15, personalP80: -400, sampleCount: 1000, prior: 10 });
  assert.deepEqual([low.correction, low.minutes], [Math.round((1000 / 1010) * -415), 15 + Math.round((1000 / 1010) * -415)]);
});

test('toMorningMinutes: 준비 + 준비 전 활동 (알람 계산은 기록이 이미 기상~출발이라 부르지 않음 — plan-core.test.ts)', () => {
  assert.equal(toMorningMinutes(40, 20), 60);
  assert.equal(toMorningMinutes(39.6, 20), 60);
});

test('P80은 percentile_cont(0.8)과 같은 선형 보간', () => {
  assert.equal(percentile([], 0.8), null);
  assert.equal(percentile([10], 0.8), 10);
  assert.equal(percentile([40, 45, 50, 50, 55, 55, 60, 65, 75, 100], 0.8), 67); // 위치 7.2 → 65 + 0.2 × 10
  assert.equal(percentile([5, 1, 3], 0.5), 3);
});

test('prepareStatsOf: 10~240분만, 앞(최신)에서 30건 — 31번째 오래된 기록과 5분 · 400분 · 빈 값은 무시', () => {
  const recent30 = Array.from({ length: 30 }, () => 60);
  const stats = prepareStatsOf([5, 400, null, undefined, ...recent30, 200, 200]); // 범위 밖 · 빈 값은 창을 차지하지 않고, 31번째부터(250)는 버림
  assert.deepEqual(stats, { sampleCount: 30, p80: 60 });
  assert.deepEqual(prepareStatsOf([10, 240]), { sampleCount: 2, p80: 194 }); // 경계값 포함
  assert.deepEqual(prepareStatsOf([9, 241, 0, -5, Number.NaN]), { sampleCount: 0, p80: null });
  assert.deepEqual(prepareStatsOf(['60', '80']), { sampleCount: 2, p80: 76 }); // numeric 칸이 글자로 와도
});

test('prepareSourceLabel: 4건까지 "배우는 중 N/5", 5건부터 "내 기록 기반 N건" (식 · P80 같은 말은 안 보임, D47)', () => {
  assert.deepEqual([0, 3, 4].map(prepareSourceLabel), ['배우는 중 0/5', '배우는 중 3/5', '배우는 중 4/5']);
  assert.deepEqual([5, 12, 30].map(prepareSourceLabel), ['내 기록 기반 5건', '내 기록 기반 12건', '내 기록 기반 30건']);
  assert.ok(![0, 4, 5, 30].some((n) => /P80|분위수|\(n/.test(prepareSourceLabel(n))));
});
