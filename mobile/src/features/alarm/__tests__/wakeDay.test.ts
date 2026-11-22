import { describe, expect, it } from '@jest/globals';

import { wakeDay } from '../realWake';

// 하루 기록의 날짜 = 알람이 울린 날 — 서버 private.wake_day(알람 시각의 [6시간 전, 18시간 뒤) 안이면 알람의 한국 날짜, 아니면 확인한 날)와 같은 규칙 (G14)
const kst = (iso: string) => new Date(`${iso}+09:00`);

describe('wakeDay', () => {
  it('자정을 넘겨 확인해도(23:50 알람 → 00:10 확인) 알람이 울린 날', () => {
    expect(wakeDay(kst('2026-11-18T23:50:00'), kst('2026-11-19T00:10:00'))).toBe('2026-11-18');
  });

  it('같은 날 확인하면 그날', () => {
    expect(wakeDay(kst('2026-11-19T07:30:00'), kst('2026-11-19T07:41:00'))).toBe('2026-11-19');
  });

  it('알람 6시간 전 · 18시간 뒤 경계 — 안이면 알람 날짜, 밖이면 확인한 날 (알람 행이 다음 회차로 재사용된 경우)', () => {
    const alarm = kst('2026-11-19T07:30:00');
    expect(wakeDay(alarm, kst('2026-11-19T01:30:00'))).toBe('2026-11-19'); // 정확히 6시간 전은 안
    expect(wakeDay(alarm, kst('2026-11-19T01:29:00'))).toBe('2026-11-19'); // 6시간 넘게 전 → 확인한 날 = 같은 날이라 결과 같음
    expect(wakeDay(kst('2026-11-18T07:30:00'), kst('2026-11-19T01:30:00'))).toBe('2026-11-19'); // 18시간 뒤(경계) → 확인한 날
    expect(wakeDay(kst('2026-11-18T07:30:00'), kst('2026-11-19T01:29:00'))).toBe('2026-11-18'); // 18시간 안 → 알람 날짜
  });

  it('알람 시각을 모르면 확인한 날', () => {
    expect(wakeDay(null, kst('2026-11-19T00:10:00'))).toBe('2026-11-19');
  });
});
