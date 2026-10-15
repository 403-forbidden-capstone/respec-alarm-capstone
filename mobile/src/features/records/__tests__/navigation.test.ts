import { describe, expect, it } from '@jest/globals';

import { dayKey } from '@/lib/format';
import { kst } from '@/mocks/data';

import { weekStart } from '../calendar';
import { canMoveNextDay, goToday, initialNav, moveDay, moveMonth, moveWeek, openDay, selectView } from '../navigation';

const today = kst(22, 0);
const key = (d: Date) => dayKey(d);

// R02 어디를 보고 있는지 (D48) — 보던 달 · 주(period)와 일간으로 보는 날(day)은 따로
describe('R02 보는 곳', () => {
  it('처음은 주간, 오늘 (D28 지금 코드 그대로)', () => {
    const nav = initialNav(kst(22, 475));
    expect([nav.view, key(nav.period), key(nav.day)]).toEqual(['week', '2025-05-22', '2025-05-22']);
    expect(nav.day.getTime()).toBe(today.getTime()); // 일간 날은 그날 0시
  });

  it('날짜를 누르면 그 날의 일간 — 보던 주는 그대로', () => {
    let nav = initialNav(today);
    nav = moveWeek(nav, -1); // 지난주 보는 중
    nav = openDay(nav, kst(14, 13 * 60));
    expect([nav.view, key(nav.day), key(weekStart(nav.period))]).toEqual(['day', '2025-05-14', '2025-05-12']);
  });

  it('월간에서 누른 날도 보던 달 그대로', () => {
    let nav = selectView(initialNav(today), 'month');
    nav = moveMonth(nav, -1); // 4월 22일
    nav = openDay(nav, kst(0, 0)); // 4월 30일
    expect([nav.view, key(nav.day), key(nav.period)]).toEqual(['day', '2025-04-30', '2025-04-22']);
  });

  it('일간 이전 · 다음은 날만 하루씩 — 주 · 달 경계를 넘어도 보던 주 · 달은 안 따라감', () => {
    let nav = openDay(moveWeek(initialNav(today), -1), kst(18, 0)); // 지난주 일요일에서 시작
    nav = moveDay(nav, 1, today); // 월요일 — 다음 주로 넘어감
    expect(key(nav.day)).toBe('2025-05-19');
    expect(key(weekStart(nav.period))).toBe('2025-05-12'); // 보던 주 그대로
    nav = moveDay(moveDay(nav, -1, today), -1, today);
    expect(key(nav.day)).toBe('2025-05-17');

    let month = openDay(selectView(initialNav(today), 'month'), kst(1, 0)); // 5월 1일
    month = moveDay(month, -1, today); // 4월 30일 — 달이 넘어감
    expect([key(month.day), key(month.period)]).toEqual(['2025-04-30', '2025-05-22']);
  });

  it('일간에서 월간 · 주간으로 돌아오면 일간을 열기 전 그 달 · 주', () => {
    let nav = openDay(moveWeek(initialNav(today), -1), kst(16, 0));
    for (let i = 0; i < 4; i++) nav = moveDay(nav, 1, today); // 5월 20일까지 넘김
    nav = selectView(nav, 'week');
    expect([nav.view, key(weekStart(nav.period)), key(nav.day)]).toEqual(['week', '2025-05-12', '2025-05-20']);
    expect(selectView(nav, 'day').day.getTime()).toBe(kst(20, 0).getTime()); // 일간 탭을 바로 누르면 마지막으로 본 날
  });

  it('다음은 오늘까지만 — 앞날은 열지 않음', () => {
    const nav = openDay(initialNav(today), kst(21, 0));
    expect(canMoveNextDay(nav, today)).toBe(true);
    const onToday = moveDay(nav, 1, today);
    expect([key(onToday.day), canMoveNextDay(onToday, today)]).toEqual(['2025-05-22', false]);
    expect(moveDay(onToday, 1, today)).toBe(onToday); // 그대로
  });

  it('오늘 버튼: 날만 오늘로, 보던 주는 그대로', () => {
    let nav = openDay(moveWeek(initialNav(today), -2), kst(7, 0));
    nav = goToday(nav, kst(22, 475));
    expect([nav.view, key(nav.day), key(weekStart(nav.period))]).toEqual(['day', '2025-05-22', '2025-05-05']);
  });

  it('앞뒤 달은 같은 날짜로, 그 달에 없으면 말일로 / 앞뒤 주는 7일', () => {
    const nav = { ...initialNav(today), period: kst(31, 0) };
    expect(key(moveMonth(nav, 1).period)).toBe('2025-06-30');
    expect(key(moveMonth(nav, -1).period)).toBe('2025-04-30');
    expect(key(moveMonth({ ...nav, period: kst(-1, 0) }, 1).period)).toBe('2025-05-29'); // 4월 29일 → 5월 29일
    expect(key(moveWeek(nav, 1).period)).toBe('2025-06-07');
    expect(key(moveWeek(nav, -1).period)).toBe('2025-05-24');
    expect(key(moveMonth(nav, 1).day)).toBe('2025-05-22'); // 일간 날은 안 건드림
  });
});
