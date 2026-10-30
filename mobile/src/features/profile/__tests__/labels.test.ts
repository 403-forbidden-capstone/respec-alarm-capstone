import { describe, expect, it } from '@jest/globals';

import { TRANSPORT_NAME, WAKE_MARGIN_NAME, WAKE_SENSITIVITY_NAME } from '../labels';

describe('프로필 값 이름', () => {
  it('값마다 이름이 있고 서로 겹치지 않음', () => {
    for (const names of [TRANSPORT_NAME, WAKE_SENSITIVITY_NAME, WAKE_MARGIN_NAME]) {
      const values = Object.values(names);
      expect(values.every((name) => name.length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('값 목록이 DB 제약과 같음 (이동 수단 5 · 잠귀 3 · 깨우는 여유 3)', () => {
    expect(Object.keys(TRANSPORT_NAME).sort()).toEqual(['BUS', 'CAR', 'SUBWAY', 'TRANSIT', 'WALK']);
    expect(Object.keys(WAKE_SENSITIVITY_NAME).sort()).toEqual(['HEAVY', 'LIGHT', 'NORMAL']);
    expect(Object.keys(WAKE_MARGIN_NAME).sort()).toEqual(['LOOSE', 'NORMAL', 'TIGHT']);
  });
});
