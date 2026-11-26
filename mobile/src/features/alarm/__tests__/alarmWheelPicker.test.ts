import { describe, expect, it } from '@jest/globals';

import { changeWheelTime, wheelIndex } from '../components/AlarmWheelPicker';
import { dayKey, minuteOfDay } from '@/lib/format';

describe('shared alarm time wheel', () => {
  const at = new Date('2026-11-27T14:03:00+09:00');
  it('rounds and clamps scroll offsets', () => {
    expect(wheelIndex(-44, 60)).toBe(0);
    expect(wheelIndex(43, 60)).toBe(1);
    expect(wheelIndex(88, 60)).toBe(2);
    expect(wheelIndex(99999, 60)).toBe(59);
  });
  it('keeps date and minute when switching period', () => {
    const am = changeWheelTime(at, 'period', 0);
    expect(dayKey(am)).toBe(dayKey(at));
    expect(minuteOfDay(am)).toBe(minuteOfDay(at) % 720);
    expect(minuteOfDay(changeWheelTime(am, 'period', 1))).toBe(minuteOfDay(am) + 720);
  });
  it('handles noon and midnight and chained changes', () => {
    const am = changeWheelTime(at, 'period', 0);
    const midnight = changeWheelTime(changeWheelTime(am, 'hour', 11), 'minute', 0);
    expect(minuteOfDay(midnight)).toBe(0);
    expect(dayKey(midnight)).toBe(dayKey(at));
    const noon = changeWheelTime(midnight, 'period', 1);
    expect(minuteOfDay(noon)).toBe(720);
    expect(minuteOfDay(changeWheelTime(changeWheelTime(noon, 'hour', 0), 'minute', 59))).toBe(839);
  });
});
