import { describe, expect, it } from '@jest/globals';

import { candidatesFromEvents, toBatch, windowOf, WINDOW_DAYS, type CalendarEventLike } from '../calendar';

// 한국 시간 2026-11-02(월) 기준 주 — 11/2 월 · 11/4 수 · 11/9 월
const day = (md: string, hhmm: string) => new Date(`2026-${md}T${hhmm}:00+09:00`);
const ev = (patch: Partial<CalendarEventLike> & { d: string; s: string; e: string }): CalendarEventLike => {
  const { d, s, e, ...rest } = patch;
  return { title: '자료구조', startDate: day(d, s), endDate: day(d, e), location: '공학관 301', recurrenceRule: null, ...rest };
};
const WEEKLY = { frequency: 'weekly', interval: 1 };

describe('windowOf', () => {
  it('오늘 0시부터 14일', () => {
    const w = windowOf(new Date('2026-11-02T15:30:00+09:00'));
    expect(w.start.toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(w.end.getTime() - w.start.getTime()).toBe(WINDOW_DAYS * 86_400_000);
  });
});

describe('candidatesFromEvents', () => {
  it('주간 반복 규칙이 붙은 일정은 한 번만 보여도 후보, 같은 시각 · 장소의 다른 요일은 한 줄로 묶음', () => {
    const out = candidatesFromEvents([
      ev({ d: '11-02', s: '10:30', e: '12:00', recurrenceRule: WEEKLY }),
      ev({ d: '11-04', s: '10:30', e: '12:00', recurrenceRule: WEEKLY }),
      ev({ d: '11-09', s: '10:30', e: '12:00', recurrenceRule: WEEKLY }),
    ]);
    expect(out).toEqual([{ title: '자료구조', weekdays: ['월', '수'], startMinutes: 630, endMinutes: 720, place: '공학관 301' }]);
  });

  it('규칙이 없어도 같은 요일 · 같은 시각이 2주에 두 번이면 후보', () => {
    const out = candidatesFromEvents([ev({ d: '11-02', s: '09:00', e: '10:00' }), ev({ d: '11-09', s: '09:00', e: '10:00' })]);
    expect(out).toHaveLength(1);
    expect(out[0].weekdays).toEqual(['월']);
  });

  it('한 번뿐이고 규칙도 없는 일정 · 격주 규칙 · 매일 규칙은 후보 아님', () => {
    const out = candidatesFromEvents([
      ev({ title: '병원', d: '11-03', s: '14:00', e: '15:00' }),
      ev({ title: '격주 모임', d: '11-05', s: '19:00', e: '20:00', recurrenceRule: { frequency: 'weekly', interval: 2 } }),
      ev({ title: '매일 약', d: '11-02', s: '08:00', e: '08:10', recurrenceRule: { frequency: 'daily' } }),
    ]);
    expect(out).toEqual([]);
  });

  it('하루 종일 · 이름 없음 · 끝이 시작보다 빠름 · 자정을 넘는 일정은 뺌', () => {
    const base = { recurrenceRule: WEEKLY };
    const out = candidatesFromEvents([
      ev({ ...base, d: '11-02', s: '00:00', e: '23:59', allDay: true }),
      ev({ ...base, title: '  ', d: '11-02', s: '10:00', e: '11:00' }),
      ev({ ...base, d: '11-02', s: '11:00', e: '11:00' }),
      { title: '야간', startDate: day('11-02', '23:00'), endDate: day('11-03', '01:00'), recurrenceRule: WEEKLY },
    ]);
    expect(out).toEqual([]);
  });

  it('장소가 없으면 null, 위치 글자 공백은 정리, 이름이 같아도 시각이 다르면 다른 줄', () => {
    const out = candidatesFromEvents([
      ev({ d: '11-02', s: '10:00', e: '11:00', location: '', recurrenceRule: WEEKLY }),
      ev({ d: '11-04', s: '13:00', e: '14:00', location: '  정보관   B102 ', recurrenceRule: WEEKLY }),
    ]);
    expect(out.map((c) => [c.startMinutes, c.place])).toEqual([
      [600, null],
      [780, '정보관 B102'],
    ]);
  });

  it('시작 시각 순으로 정렬, 문자열 날짜도 읽음', () => {
    const out = candidatesFromEvents([
      { title: 'B', startDate: '2026-11-03T05:00:00.000Z', endDate: '2026-11-03T06:00:00.000Z', recurrenceRule: WEEKLY }, // 화 14:00 KST
      { title: 'A', startDate: '2026-11-03T00:00:00.000Z', endDate: '2026-11-03T01:00:00.000Z', recurrenceRule: WEEKLY }, // 화 09:00 KST
    ]);
    expect(out.map((c) => c.title)).toEqual(['A', 'B']);
    expect(out[0].weekdays).toEqual(['화']);
  });

  it('일요일은 요일 순서의 맨 뒤', () => {
    const out = candidatesFromEvents([ev({ d: '11-01', s: '10:00', e: '11:00', recurrenceRule: WEEKLY }), ev({ d: '11-02', s: '10:00', e: '11:00', recurrenceRule: WEEKLY })]);
    expect(out[0].weekdays).toEqual(['월', '일']);
  });
});

describe('toBatch', () => {
  it('캘린더 길로 표시, confidence 없음', () => {
    expect(toBatch([])).toEqual({ source: 'calendar', classes: [] });
  });
});
