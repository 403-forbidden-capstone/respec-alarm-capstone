import { describe, expect, it } from '@jest/globals';

import { dbTimeMs, normalizeDbTime, parseDbTime } from '../dbTime';

// 2026-10-16 05:12:45.123 UTC (한국 14:12:45.123)
const MS = Date.UTC(2026, 9, 16, 5, 12, 45, 123);

describe('DB 시각 글자 읽기 (parseDbTime)', () => {
  it('PostgREST의 마이크로초 6자리를 밀리초 3자리로 잘라 읽음', () => {
    expect(normalizeDbTime('2026-10-16T05:12:45.123456+00:00')).toBe('2026-10-16T05:12:45.123+00:00');
    expect(parseDbTime('2026-10-16T05:12:45.123456+00:00').getTime()).toBe(MS);
    expect(dbTimeMs('2026-10-16T05:12:45.123999+00:00')).toBe(MS); // 올림이 아니라 자름
  });

  it('소수 3자리는 그대로', () => {
    expect(normalizeDbTime('2026-10-16T05:12:45.123Z')).toBe('2026-10-16T05:12:45.123Z');
    expect(parseDbTime('2026-10-16T05:12:45.123Z').getTime()).toBe(MS);
  });

  it('소수 1~2자리(Postgres는 끝의 0을 뺌)는 0으로 채움', () => {
    expect(normalizeDbTime('2026-10-16T05:12:45.12+00:00')).toBe('2026-10-16T05:12:45.120+00:00');
    expect(parseDbTime('2026-10-16T05:12:45.1+00:00').getTime()).toBe(Date.UTC(2026, 9, 16, 5, 12, 45, 100));
  });

  it('소수가 없으면 그대로', () => {
    expect(normalizeDbTime('2026-10-16T05:12:45+00:00')).toBe('2026-10-16T05:12:45+00:00');
    expect(parseDbTime('2026-10-16T05:12:45Z').getTime()).toBe(Date.UTC(2026, 9, 16, 5, 12, 45));
  });

  it('시차는 Z · +09:00 · 분 없는 +09 · +0900을 모두 읽음', () => {
    const kst = Date.UTC(2026, 9, 16, 5, 12, 45, 123); // 한국 14:12:45.123 = UTC 05:12:45.123
    expect(parseDbTime('2026-10-16T14:12:45.123456+09:00').getTime()).toBe(kst);
    expect(parseDbTime('2026-10-16T14:12:45.123456+09').getTime()).toBe(kst);
    expect(parseDbTime('2026-10-16T14:12:45.123456+0900').getTime()).toBe(kst);
    expect(parseDbTime('2026-10-16T00:12:45.123456-05:00').getTime()).toBe(Date.UTC(2026, 9, 16, 5, 12, 45, 123));
    expect(parseDbTime('2026-10-16T05:12:45.123456+00').getTime()).toBe(MS);
  });

  it('날짜와 시각 사이가 공백인 글자도 읽음', () => {
    expect(parseDbTime('2026-10-16 05:12:45.123456+00').getTime()).toBe(MS);
  });

  it('날짜만 있는 글자나 읽을 수 없는 글자는 new Date와 같게 둠', () => {
    expect(normalizeDbTime('2026-10-16')).toBe('2026-10-16');
    expect(parseDbTime('2026-10-16').getTime()).toBe(Date.UTC(2026, 9, 16));
    expect(Number.isNaN(parseDbTime('날짜 아님').getTime())).toBe(true);
    expect(Number.isNaN(dbTimeMs(''))).toBe(true);
  });
});
