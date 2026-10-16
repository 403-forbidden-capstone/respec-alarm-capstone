import { describe, expect, it } from '@jest/globals';

import { isUuid, stableUuid } from '../uuid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('고정 UUID (stableUuid)', () => {
  it('같은 입력이면 늘 같은 값, UUID 모양', () => {
    const a = stableUuid('wake-confirmed', 'alarm-1', 1_700_000_000_000);
    expect(a).toMatch(UUID);
    expect(stableUuid('wake-confirmed', 'alarm-1', 1_700_000_000_000)).toBe(a);
  });

  it('입력이 하나라도 다르면 다른 값', () => {
    const base = stableUuid('wake-confirmed', 'alarm-1', 1_700_000_000_000);
    expect(stableUuid('wake-confirmed', 'alarm-2', 1_700_000_000_000)).not.toBe(base);
    expect(stableUuid('wake-confirmed', 'alarm-1', 1_700_000_000_001)).not.toBe(base);
    expect(stableUuid('wake-missed', 'alarm-1', 1_700_000_000_000)).not.toBe(base);
  });

  it('조각의 경계도 구분함', () => {
    expect(stableUuid('ab', 'c')).not.toBe(stableUuid('a', 'bc'));
    expect(stableUuid('1', 2)).not.toBe(stableUuid(1, '2')); // 글자 1과 숫자 1은 다른 입력
  });

  it('많은 입력에서도 겹치지 않음', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(stableUuid('wake-confirmed', `alarm-${i % 50}`, i));
    expect(seen.size).toBe(5_000);
  });
});

describe('UUID 모양 확인 (isUuid)', () => {
  it('UUID 모양이면 true (대소문자 무관), 가짜 데이터 시절 id나 빈 글자는 false', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
    expect(isUuid(stableUuid('x'))).toBe(true);
    for (const value of ['m1', 'a1:WAKE', '', '00000000-0000-4000-8000-00000000000', '00000000-0000-4000-8000-0000000000012', ' 00000000-0000-4000-8000-000000000001']) {
      expect(isUuid(value)).toBe(false);
    }
  });
});
