import { describe, expect, it } from '@jest/globals';

import { WEEKDAYS } from '@/lib/weekday';

import { EVERY_DAY, repeatLabel, repeatToRrule, rruleToRepeat, sameDays, sortDays, toggleWeekday, WEEKDAYS_ONLY } from '../repeat';

describe('H05 반복 — 요일 집합 ⇄ RRULE (D44)', () => {
  it('요일이 없으면 반복 없음(null), 모든 요일이면 매일, 그 밖은 주간 + 요일 코드(월요일부터)', () => {
    expect(repeatToRrule([])).toBeNull();
    expect(repeatToRrule([...WEEKDAYS])).toBe('FREQ=DAILY');
    expect(repeatToRrule(['목'])).toBe('FREQ=WEEKLY;BYDAY=TH');
    expect(repeatToRrule(['수', '월'])).toBe('FREQ=WEEKLY;BYDAY=MO,WE'); // 고른 순서가 아니라 월요일부터
    expect(repeatToRrule(WEEKDAYS_ONLY)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(repeatToRrule(['일', '토'])).toBe('FREQ=WEEKLY;BYDAY=SA,SU');
  });

  it('RRULE을 다시 요일로 — 쓴 규칙은 그대로 돌아오고, 모르는 글자 · 요일 없는 주간은 반복 없음', () => {
    for (const days of [['월', '수'], ['목'], [...WEEKDAYS], [...WEEKDAYS_ONLY], ['토', '일']] as const) {
      expect(rruleToRepeat(repeatToRrule(days))).toEqual(sortDays(days));
    }
    expect(rruleToRepeat(null)).toEqual([]);
    expect(rruleToRepeat(undefined)).toEqual([]);
    expect(rruleToRepeat('')).toEqual([]);
    expect(rruleToRepeat('FREQ=MONTHLY;BYMONTHDAY=3')).toEqual([]);
    expect(rruleToRepeat('FREQ=WEEKLY')).toEqual([]);
    expect(rruleToRepeat('FREQ=WEEKLY;BYDAY=XX')).toEqual([]);
  });

  it('RRULE 앞 접두사 · 소문자 · 순서가 달라도 읽음 (DB에서 온 글자)', () => {
    expect(rruleToRepeat('RRULE:FREQ=WEEKLY;BYDAY=WE,MO')).toEqual(['월', '수']);
    expect(rruleToRepeat('freq=weekly;byday=fr')).toEqual(['금']);
    expect(rruleToRepeat('BYDAY=MO;FREQ=WEEKLY')).toEqual(['월']);
  });
});

describe('H05 반복 — 화면 글자', () => {
  it('없음 · 매일 · 평일 · 요일 하나 · 요일 여러 개', () => {
    expect(repeatLabel([])).toBe('반복 없음');
    expect(repeatLabel(EVERY_DAY)).toBe('매일');
    expect(repeatLabel(WEEKDAYS_ONLY)).toBe('평일');
    expect(repeatLabel(['목'])).toBe('매주 목요일');
    expect(repeatLabel(['수', '월'])).toBe('매주 월 · 수');
    expect(repeatLabel(['토', '일'])).toBe('매주 토 · 일'); // 주말 이름은 정하지 않음
  });

  it('평일에 하루를 더하면 평일이 아님', () => {
    expect(repeatLabel([...WEEKDAYS_ONLY, '토'])).toBe('매주 월 · 화 · 수 · 목 · 금 · 토');
  });

  it('RRULE로 쓴 규칙의 글자 — 시드 일정의 "매주 목요일"과 같음', () => {
    expect(repeatLabel(rruleToRepeat('FREQ=WEEKLY;BYDAY=TH'))).toBe('매주 목요일');
    expect(repeatLabel(rruleToRepeat('FREQ=DAILY'))).toBe('매일');
  });
});

describe('H05 반복 — 요일 칩 · 빠른 선택', () => {
  it('요일 칩을 누르면 켜고 끄고, 늘 월요일부터 순서대로', () => {
    expect(toggleWeekday([], '수')).toEqual(['수']);
    expect(toggleWeekday(['수'], '월')).toEqual(['월', '수']);
    expect(toggleWeekday(['월', '수'], '월')).toEqual(['수']);
    expect(toggleWeekday(['수'], '수')).toEqual([]);
  });

  it('같은 요일 집합인지는 순서와 상관없음', () => {
    expect(sameDays(['수', '월'], ['월', '수'])).toBe(true);
    expect(sameDays(EVERY_DAY, WEEKDAYS_ONLY)).toBe(false);
  });
});
