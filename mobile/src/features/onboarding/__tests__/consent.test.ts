import { describe, expect, it } from '@jest/globals';

import { CONSENT_ITEMS, consentItems } from '../consent';

describe('consentItems — 켜 둔 시간표 가져오기 길만 동의 항목에 더함', () => {
  it('둘 다 꺼져 있으면 기본 항목 그대로', () => {
    expect(consentItems({ photo: false, calendar: false })).toEqual(CONSENT_ITEMS);
  });

  it('사진을 켜면 시간표 사진 항목, 캘린더를 켜면 캘린더 항목 (기본 항목 뒤에)', () => {
    expect(consentItems({ photo: true, calendar: false }).map((i) => i.key)).toEqual([...CONSENT_ITEMS.map((i) => i.key), 'timetable-photo']);
    expect(consentItems({ photo: false, calendar: true }).map((i) => i.key)).toEqual([...CONSENT_ITEMS.map((i) => i.key), 'timetable-calendar']);
    expect(consentItems({ photo: true, calendar: true }).map((i) => i.title).slice(-2)).toEqual(['시간표 사진', '캘린더']);
  });

  it('사진 항목은 저장하지 않는다고 알림', () => {
    const photo = consentItems({ photo: true, calendar: false }).find((i) => i.key === 'timetable-photo');
    expect(photo?.doesNotRead).toMatch(/저장하지 않고/);
  });
});
