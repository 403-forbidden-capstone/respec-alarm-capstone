import { describe, expect, it } from '@jest/globals';

import { toUseSpans } from '../usage';

describe('화면 사용 구간 → 해제 뒤 분 (wake.ts UseSpan)', () => {
  const dismissedAt = Date.UTC(2026, 9, 16, 22, 0, 0); // 임의의 해제 시각

  it('해제 시각을 빼서 분으로 바꿈', () => {
    const spans = [
      { startMillis: dismissedAt + 30_000, endMillis: dismissedAt + 90_000 },
      { startMillis: dismissedAt + 150_000, endMillis: dismissedAt + 198_000 },
    ];
    expect(toUseSpans(spans, dismissedAt)).toEqual([
      [0.5, 1.5],
      [2.5, 3.3],
    ]);
  });

  it('해제 전에 시작한 구간은 음수로 두고 자르는 건 wake.ts에 맡김', () => {
    expect(toUseSpans([{ startMillis: dismissedAt - 60_000, endMillis: dismissedAt + 60_000 }], dismissedAt)).toEqual([
      [-1, 1],
    ]);
  });

  it('구간이 없으면 빈 목록', () => {
    expect(toUseSpans([], dismissedAt)).toEqual([]);
  });
});
