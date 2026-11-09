import { describe, expect, it } from '@jest/globals';

import { VIEW_ALARM_NOTE } from '../types';

// 친구 13장 앱 층 (시험케이스 13-22) — F03 알람 조회 안내 문구. 동의 항목 · 만 14세 확인은 onboarding/__tests__/consent.test.ts
describe('F03 알람 조회 안내 (13-22)', () => {
  it("'일정 장소도 보여요 · 집 · 출발지는 안 보여요'", () => {
    expect(VIEW_ALARM_NOTE).toBe('일정 장소도 보여요 · 집 · 출발지는 안 보여요');
  });
});
