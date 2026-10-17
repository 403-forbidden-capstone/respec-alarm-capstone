import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatKoTime, localDayRange, offsetMinutes, safeTimeZone } from './tz.ts';

test('서울은 UTC보다 540분 앞섬', () => {
  assert.equal(offsetMinutes(new Date('2026-10-20T00:00:00Z'), 'Asia/Seoul'), 540);
});

test('시각 글자: 오전 10:00 · 오후 6:05 · 낮 12시 · 자정', () => {
  assert.equal(formatKoTime(new Date('2026-10-20T01:00:00Z'), 'Asia/Seoul'), '오전 10:00');
  assert.equal(formatKoTime(new Date('2026-10-20T09:05:00Z'), 'Asia/Seoul'), '오후 6:05');
  assert.equal(formatKoTime(new Date('2026-10-20T03:00:00Z'), 'Asia/Seoul'), '오후 12:00');
  assert.equal(formatKoTime(new Date('2026-10-19T15:00:00Z'), 'Asia/Seoul'), '오전 12:00');
});

test('그날의 0시 ~ 다음 날 0시 (서울)', () => {
  const { start, end } = localDayRange(new Date('2026-10-20T01:00:00Z'), 'Asia/Seoul'); // 한국 10/20 10:00
  assert.equal(start.toISOString(), '2026-10-19T15:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-20T15:00:00.000Z');
  // 한국 시각 새벽은 UTC로는 전날이지만 한국 기준 그날
  assert.equal(localDayRange(new Date('2026-10-19T16:00:00Z'), 'Asia/Seoul').start.toISOString(), '2026-10-19T15:00:00.000Z');
});

test('일광절약시간 시간대도 하루 길이가 맞음 (뉴욕 2026-11-01은 25시간)', () => {
  const { start, end } = localDayRange(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
  assert.equal(start.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(end.toISOString(), '2026-11-02T05:00:00.000Z');
});

test('모르는 시간대는 서울로', () => {
  assert.equal(safeTimeZone('Mars/Olympus'), 'Asia/Seoul');
  assert.equal(safeTimeZone(null), 'Asia/Seoul');
  assert.equal(safeTimeZone('America/New_York'), 'America/New_York');
});
