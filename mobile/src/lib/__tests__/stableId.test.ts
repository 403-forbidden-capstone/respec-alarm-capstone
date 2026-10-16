import { describe, expect, it } from '@jest/globals';

import { stableUuid } from '../stableId';

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
