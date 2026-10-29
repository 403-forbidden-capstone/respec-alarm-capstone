import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatKoTime, localDateKey, localDayRange, localMinuteOfDay, offsetMinutes, safeTimeZone, zonedTime } from './tz.ts';

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

test('내 시간대의 날짜 글자와 0시부터 분 — 새벽 1시는 UTC로는 전날이지만 한국 날짜', () => {
  const dawn = new Date('2026-11-10T16:00:00Z'); // 한국 11/11 01:00
  assert.equal(localDateKey(dawn, 'Asia/Seoul'), '2026-11-11');
  assert.equal(localMinuteOfDay(dawn, 'Asia/Seoul'), 60);
  assert.equal(localDateKey(dawn, 'America/Los_Angeles'), '2026-11-10'); // 같은 순간이 LA에서는 11/10 08:00
  assert.equal(localMinuteOfDay(dawn, 'America/Los_Angeles'), 480);
  assert.equal(localDateKey(new Date('2026-10-19T14:59:00Z'), 'Asia/Seoul'), '2026-10-19');
  assert.equal(localDateKey(new Date('2026-10-19T15:00:00Z'), 'Asia/Seoul'), '2026-10-20');
  assert.equal(localMinuteOfDay(new Date('2026-10-19T15:00:00Z'), 'Asia/Seoul'), 0);
  assert.equal(localMinuteOfDay(new Date('2026-10-20T14:59:00Z'), 'Asia/Seoul'), 23 * 60 + 59);
});

test('zonedTime: 날짜 + 0시부터 분 → 시각 (서울)', () => {
  assert.equal(zonedTime('2026-11-11', 450, 'Asia/Seoul').toISOString(), '2026-11-10T22:30:00.000Z'); // 오전 7:30
  assert.equal(zonedTime('2026-11-11', 60, 'Asia/Seoul').toISOString(), '2026-11-10T16:00:00.000Z'); // 새벽 1시
  assert.equal(zonedTime('2026-11-11', 0, 'Asia/Seoul').toISOString(), '2026-11-10T15:00:00.000Z'); // 0시 = localDayRange의 시작
  assert.equal(zonedTime('2026-11-11', 1470, 'Asia/Seoul').toISOString(), '2026-11-11T15:30:00.000Z'); // 24:30 = 다음 날 00:30 (자정을 넘는 루틴 단계)
  assert.equal(zonedTime('2026-02-28', 1440, 'Asia/Seoul').toISOString(), zonedTime('2026-03-01', 0, 'Asia/Seoul').toISOString()); // 달 넘김
  assert.throws(() => zonedTime('2026-11-1', 0, 'Asia/Seoul'), RangeError);
  assert.throws(() => zonedTime('내일', 0, 'Asia/Seoul'), RangeError);
});

test('zonedTime: 일광절약시간 시간대도 같은 벽시계 시각 (뉴욕)', () => {
  assert.equal(zonedTime('2026-07-01', 9 * 60, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z'); // EDT -4
  assert.equal(zonedTime('2026-12-01', 9 * 60, 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z'); // EST -5
  assert.equal(zonedTime('2026-11-01', 12 * 60, 'America/New_York').toISOString(), '2026-11-01T17:00:00.000Z'); // 시계가 되돌아간 날 낮 (EST)
  assert.equal(zonedTime('2026-11-01', 90, 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z'); // 01:30은 두 번 — 먼저 오는 쪽(EDT)
  assert.equal(zonedTime('2026-03-08', 150, 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z'); // 02:30은 없는 시각 — 03:30 EDT로 밂
  assert.equal(zonedTime('2026-03-08', 3 * 60 + 30, 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
});

test('zonedTime은 localDateKey · localMinuteOfDay의 반대 (여러 시간대 · 하루 모든 분, 봄에 건너뛰는 구간만 뒤로 밀림)', () => {
  // 봄에 시계가 건너뛰는 날: 시간대 → [날짜, 건너뛰기 시작 분, 건너뛰는 길이(분)]
  const gaps: Record<string, [string, number, number]> = { 'America/New_York': ['2026-03-08', 120, 60], 'Europe/London': ['2026-03-29', 60, 60], 'Australia/Lord_Howe': ['2026-10-04', 120, 30] };
  for (const tz of ['Asia/Seoul', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
    for (const date of ['2026-03-08', '2026-03-29', '2026-10-04', '2026-10-25', '2026-11-01', '2026-11-11']) {
      const gap = gaps[tz]?.[0] === date ? gaps[tz] : undefined;
      for (let minute = 0; minute < 1440; minute += 5) {
        const at = zonedTime(date, minute, tz);
        const pushed = gap && minute >= gap[1] && minute < gap[1] + gap[2] ? gap[2] : 0; // 건너뛰는 구간이면 건너뛰는 길이만큼 뒤
        assert.equal(localDateKey(at, tz), date, `${tz} ${date} ${minute}`);
        assert.equal(localMinuteOfDay(at, tz), minute + pushed, `${tz} ${date} ${minute}`);
      }
    }
  }
  for (const tz of ['Asia/Seoul', 'America/Los_Angeles']) {
    const at = new Date('2026-11-10T16:00:00Z');
    assert.equal(zonedTime(localDateKey(at, tz), localMinuteOfDay(at, tz), tz).toISOString(), at.toISOString());
  }
});
