// 알람 조정 제안 (ALG-07) — 목업 S01 예시 · 준비 전 시간이 모자랄 때(안건 초안 D111 2번 B) · 문턱 · 상한
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectOverrun, sizeAdvance, suggestPrepareAdvance, wakeShift } from './suggest.ts';

test('목업 S01 예시 — 최근 3번 +10 · +14 · +12분, 준비 전 10분이면 준비만 10분 당김', () => {
  const s = suggestPrepareAdvance({ residuals: [2, 10, 14, 12], beforePrepareMinutes: 10, capMinutes: 10 });
  assert.deepEqual(s, { minutes: 10, wakeMinutes: 0, evidence: [10, 14, 12], overrun: 12 });
});

test('준비 전 시간이 모자라면 모자란 만큼만 기상도 당김', () => {
  const s = suggestPrepareAdvance({ residuals: [16, 18, 17], beforePrepareMinutes: 10, capMinutes: 30 });
  assert.equal(s?.minutes, 15);
  assert.equal(s?.wakeMinutes, 5);
  assert.equal(wakeShift(10, 20), 0);
  assert.equal(wakeShift(10, 0), 10);
});

test('기상 알람이 없는 일정은 기상을 당기지 않음', () => {
  assert.equal(suggestPrepareAdvance({ residuals: [20, 20, 20], beforePrepareMinutes: Infinity, capMinutes: 30 })?.wakeMinutes, 0);
});

test('최근 3번 중 하나라도 예측 안이면 제안 안 함', () => {
  assert.equal(detectOverrun([12, -1, 14]), null);
  assert.equal(detectOverrun([12, 0, 14]), null);
});

test('평균 초과가 5분 미만이거나 기록이 3번 미만이면 제안 안 함', () => {
  assert.equal(suggestPrepareAdvance({ residuals: [3, 4, 6], beforePrepareMinutes: 20, capMinutes: 10 }), null);
  assert.equal(suggestPrepareAdvance({ residuals: [12, 14], beforePrepareMinutes: 20, capMinutes: 10 }), null);
});

test('5분 단위로 내리고 D62 상한을 넘지 않음', () => {
  assert.equal(sizeAdvance(12, 10), 10);
  assert.equal(sizeAdvance(24, 10), 10);
  assert.equal(sizeAdvance(24, 5), 5);
  assert.equal(sizeAdvance(7, 3), 0);
});
