import { describe, expect, it } from '@jest/globals';

import { AGE_CHECK_LABEL, CONSENT_ITEMS, consentBlocked, consentItems, PRIVACY_VERSION } from '../consent';

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

// 친구 13장 앱 층 (시험케이스 13-12 · 13-14 · 13-19 · 13-20) — 온보딩 동의 1장에 '공유를 켜면 그 사람이 보는 것' 줄 + 만 14세 이상 체크
describe('친구 공유 동의 · 만 14세 확인 (13장)', () => {
  it('동의 1장에 알람 공유 항목: 켠 사람에게만 보이는 것(알람 시간 · 제목 · 장소 · 준비 시간)과 안 보이는 것(집 · 출발지 · 위치로 잡은 시각 · 수면 시간 · 메모)', () => {
    const share = CONSENT_ITEMS.find((i) => i.key === 'alarm-share');
    expect(share?.reads).toMatch(/알람 시간 · 일정 제목 · 장소 · 준비 시간/);
    expect(share?.doesNotRead).toMatch(/집 · 출발지/);
    expect(share?.doesNotRead).toMatch(/수면 시간/);
    expect(share?.friends).toMatch(/켠 사람에게만/);
  });

  it('친구는 내 출발 · 도착(위치로 잡은 것)을 못 봄 — 위치 항목은 친구에게 안 보임 (13-나)', () => {
    expect(CONSENT_ITEMS.find((i) => i.key === 'location')?.friends).toBe('안 보임');
  });

  it('만 14세 이상을 체크하지 않으면 동의 단계를 못 넘음, 이미 이 판에 동의한 계정은 다시 묻지 않음 (13-20)', () => {
    expect(AGE_CHECK_LABEL).toBe('만 14세 이상이에요');
    expect(consentBlocked(false, false)).toBe(true);
    expect(consentBlocked(false, true)).toBe(false);
    expect(consentBlocked(true, false)).toBe(false);
  });

  it('문구가 바뀌었으므로 동의 판 번호를 올림 — 판이 올라가면 다시 동의 (13-14)', () => {
    expect(PRIVACY_VERSION).toBeGreaterThanOrEqual(3);
  });
});
