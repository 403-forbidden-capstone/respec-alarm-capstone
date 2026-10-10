import { describe, expect, it } from '@jest/globals';

import { dayKey, formatDateShort } from '@/lib/format';
import { kst } from '@/mocks/data';

import {
  calendarRows,
  dateOf,
  dayWord,
  daysInMonth,
  leadingBlanks,
  monthDays,
  monthTitle,
  shiftMonth,
  weekDays,
  weekRelative,
  weekStart,
  weekTitle,
} from '../calendar';

// R02 달력 — 한국 시간 · 월요일 시작
describe('달 계산', () => {
  it('dateOf는 그날 한국 0시', () => {
    expect(dateOf(2025, 5, 22).getTime()).toBe(kst(22, 0).getTime());
    expect(dateOf(2025, 5, 22).toISOString()).toBe('2025-05-21T15:00:00.000Z');
  });

  it('날짜 수 — 윤년 2월 포함', () => {
    expect(daysInMonth(2025, 5)).toBe(31);
    expect(daysInMonth(2025, 4)).toBe(30);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it('1일 앞 빈칸 — 2025년 5월 1일은 목요일이라 3칸, 9월 1일은 월요일이라 0칸, 6월 1일은 일요일이라 6칸', () => {
    expect(leadingBlanks(2025, 5)).toBe(3);
    expect(leadingBlanks(2025, 9)).toBe(0);
    expect(leadingBlanks(2025, 6)).toBe(6);
  });

  it('그 달 날짜 목록', () => {
    const days = monthDays(2025, 5);
    expect(days).toHaveLength(31);
    expect(dayKey(days[0])).toBe('2025-05-01');
    expect(dayKey(days[30])).toBe('2025-05-31');
  });

  it('앞뒤 달 — 해가 넘어감', () => {
    expect(shiftMonth(2025, 5, 1)).toEqual({ year: 2025, month: 6 });
    expect(shiftMonth(2025, 12, 1)).toEqual({ year: 2026, month: 1 });
    expect(shiftMonth(2025, 1, -1)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth(2025, 5, -17)).toEqual({ year: 2023, month: 12 });
  });

  it('달력 줄 — 7칸씩, 앞 · 끝 빈칸은 null', () => {
    const rows = calendarRows(3, monthDays(2025, 5).map((d) => dayKey(d).slice(-2)));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual([null, null, null, '01', '02', '03', '04']);
    expect(rows[4]).toEqual(['26', '27', '28', '29', '30', '31', null]);
    expect(calendarRows(0, [1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
  });

  it('제목', () => {
    expect(monthTitle(2025, 5)).toBe('2025년 5월');
  });
});

describe('주 계산', () => {
  it('그 주 월요일 0시 — 일요일 밤 · 월요일 0시도 한국 시간으로', () => {
    expect(dayKey(weekStart(kst(22, 475)))).toBe('2025-05-19'); // 목 오전 7:55
    expect(dayKey(weekStart(kst(25, 23 * 60 + 59)))).toBe('2025-05-19'); // 일 밤 11:59
    expect(dayKey(weekStart(kst(26, 0)))).toBe('2025-05-26'); // 월 0시
    expect(weekStart(kst(22, 475)).getTime()).toBe(kst(19, 0).getTime());
  });

  it('월요일부터 일요일까지 7일', () => {
    expect(weekDays(kst(22, 0)).map((d) => dayKey(d).slice(-2))).toEqual(['19', '20', '21', '22', '23', '24', '25']);
  });

  it('제목 — 달이 넘어가면 뒤에도 달', () => {
    expect(weekTitle(kst(22, 0))).toBe('5월 19일 — 25일');
    expect(weekTitle(kst(28, 0))).toBe('5월 26일 — 6월 1일');
  });

  it('오늘 기준 몇 주 전 · 뒤', () => {
    const today = kst(22, 0);
    expect(weekRelative(kst(19, 0), today)).toBe('이번 주');
    expect(weekRelative(kst(12, 0), today)).toBe('지난주');
    expect(weekRelative(kst(26, 0), today)).toBe('다음 주');
    expect(weekRelative(kst(5, 0), today)).toBe('2주 전');
    expect(weekRelative(kst(40, 0), today)).toBe('3주 뒤');
  });
});

describe('날 말투', () => {
  const morning = kst(22, 475);

  it('오늘 · 내일 · 그 밖은 날짜', () => {
    expect(dayWord(kst(22, 1080), morning)).toBe('오늘');
    expect(dayWord(kst(23, 440), morning)).toBe('내일');
    expect(dayWord(kst(24, 440), morning)).toBe(formatDateShort(kst(24, 440)));
  });

  it('전날 밤 기준이면 모레는 날짜로', () => {
    expect(dayWord(kst(23, 440), kst(21, 1260))).toBe('5월 23일 금');
  });
});
