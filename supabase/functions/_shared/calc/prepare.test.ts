// 예측 준비 시간 — 앱 목업 estimateAppointment의 "공통 P80 + 개인 보정"과 같은 숫자
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_COMMON_P80, percentile, predictPrepare, toMorningMinutes } from './prepare.ts';

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

test('내 준비(출발 − 준비 시작) P80을 기상~출발 기준으로 바꿈', () => {
  assert.equal(toMorningMinutes(40, 20), 60);
  assert.equal(toMorningMinutes(39.6, 20), 60);
});

test('P80은 percentile_cont(0.8)과 같은 선형 보간', () => {
  assert.equal(percentile([], 0.8), null);
  assert.equal(percentile([10], 0.8), 10);
  assert.equal(percentile([40, 45, 50, 50, 55, 55, 60, 65, 75, 100], 0.8), 67); // 위치 7.2 → 65 + 0.2 × 10
  assert.equal(percentile([5, 1, 3], 0.5), 3);
});
