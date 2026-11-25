import { describe, expect, it } from '@jest/globals';

import type { WakePingResult } from '../types';
import { wakePingLocked } from '../wakePingLock';

// [깨우기] 잠금 — G02 · G03 공용 (G03에 있던 계산을 그대로 옮김, 동작 불변)
const NEXT = new Date('2026-11-10T23:20:00.000Z');
const before = new Date('2026-11-10T23:19:59.000Z');
const after = new Date('2026-11-10T23:20:00.000Z');

describe('wakePingLocked', () => {
  it('아직 안 보냈으면 안 잠김', () => {
    expect(wakePingLocked(null, after)).toBe(false);
    expect(wakePingLocked(undefined, after)).toBe(false);
  });

  it('OK(1/3) — 다음 가능 시각 전까지 잠기고 그 시각부터 풀림', () => {
    const ping: WakePingResult = { status: 'OK', count: 1, limit: 3, nextAt: NEXT };
    expect(wakePingLocked(ping, before)).toBe(true);
    expect(wakePingLocked(ping, after)).toBe(false);
  });

  it('OK 마지막(3/3) — 시간이 지나도 계속 잠김', () => {
    const ping: WakePingResult = { status: 'OK', count: 3, limit: 3, nextAt: NEXT };
    expect(wakePingLocked(ping, before)).toBe(true);
    expect(wakePingLocked(ping, after)).toBe(true);
  });

  it('WAIT — 다음 가능 시각 전까지 잠기고 그 시각부터 풀림, 시각이 없으면 계속 잠김', () => {
    expect(wakePingLocked({ status: 'WAIT', nextAt: NEXT }, before)).toBe(true);
    expect(wakePingLocked({ status: 'WAIT', nextAt: NEXT }, after)).toBe(false);
    expect(wakePingLocked({ status: 'WAIT', nextAt: null }, after)).toBe(true);
  });

  it('한도 · 꺼짐 · 이미 일어남은 계속 잠김', () => {
    for (const status of ['DAILY_LIMIT', 'OFF', 'ALREADY_UP'] as const) {
      expect(wakePingLocked({ status }, after)).toBe(true);
    }
  });

  it('아직 안 울림 · 알림이 안 닿음은 안 잠김', () => {
    expect(wakePingLocked({ status: 'NOT_RINGING' }, after)).toBe(false);
    expect(wakePingLocked({ status: 'NO_TOKENS' }, after)).toBe(false);
  });
});
