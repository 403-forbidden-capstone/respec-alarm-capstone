import { describe, expect, it } from '@jest/globals';

import { defaultRingTime, firstRingAt } from '../standalone';
import { EVERY_DAY, WEEKDAYS_ONLY } from '../repeat';

// 2026-11-21 토 · 22 일 · 23 월 · 24 화 · 30 월 (한국 시간)
const kst = (s: string) => new Date(`${s}+09:00`);
const hm = (h: number, m = 0) => h * 60 + m;

describe('기본 알람 처음 시각 (#588)', () => {
  it('지금 다음 정각', () => {
    expect(defaultRingTime(kst('2026-11-23T14:13:27'))).toEqual(kst('2026-11-23T15:00:00'));
    expect(defaultRingTime(kst('2026-11-23T14:00:00'))).toEqual(kst('2026-11-23T15:00:00'));
    expect(defaultRingTime(kst('2026-11-23T23:40:00'))).toEqual(kst('2026-11-24T00:00:00'));
  });
});

describe('기본 알람 첫 울림 (#588)', () => {
  const mon = kst('2026-11-23T14:13:00');

  it('반복 없음 — 오늘 그 시각이 남았으면 오늘, 지났거나 지금이면 내일', () => {
    expect(firstRingAt(hm(15), [], mon)).toEqual(kst('2026-11-23T15:00:00'));
    expect(firstRingAt(hm(9), [], mon)).toEqual(kst('2026-11-24T09:00:00'));
    expect(firstRingAt(hm(14, 13), [], mon)).toEqual(kst('2026-11-24T14:13:00'));
  });

  it('반복 — 고른 요일 중 지금 뒤로 첫날', () => {
    const sat = kst('2026-11-21T10:00:00');
    expect(firstRingAt(hm(7), WEEKDAYS_ONLY, sat)).toEqual(kst('2026-11-23T07:00:00')); // 평일 → 월요일
    expect(firstRingAt(hm(7), EVERY_DAY, sat)).toEqual(kst('2026-11-22T07:00:00')); // 매일 → 내일
    expect(firstRingAt(hm(11), ['토'], sat)).toEqual(kst('2026-11-21T11:00:00')); // 오늘 요일 · 시각이 남음
    expect(firstRingAt(hm(7), ['월'], kst('2026-11-23T08:00:00'))).toEqual(kst('2026-11-30T07:00:00')); // 오늘 요일인데 지남 → 다음 주
  });

  it('자정 넘어가는 시각도 한국 날짜 기준', () => {
    expect(firstRingAt(hm(0, 10), [], kst('2026-11-22T23:30:00'))).toEqual(kst('2026-11-23T00:10:00'));
    expect(firstRingAt(hm(0, 10), ['화'], kst('2026-11-22T23:30:00'))).toEqual(kst('2026-11-24T00:10:00'));
  });
});
