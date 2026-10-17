// R02 나의 기록 — 어디를 보고 있는지 (D48 날짜 이동). 화면은 이 상태를 들고 아래 함수로만 바꿈
// 규칙 (작성자 판단 — decisions.md D48 "보던 달 · 주 유지"를 글자 그대로 옮김):
//  · period = 월간 · 주간이 같이 쓰는 "보던 기간"(그 달 · 그 주가 든 날), day = 일간으로 보는 날 — 둘을 따로 둠
//  · 월간 · 주간에서 날짜를 누르면 day만 그 날로 바뀌고 일간이 열림. period는 그대로
//  · 일간의 이전 · 다음은 day만 하루씩 옮김. 주 · 달 경계를 넘어도 period는 따라가지 않음
//    → 월간 · 주간으로 돌아오면 일간을 열기 전에 보던 그 달 · 그 주
//    (따라가게 바꾸려면 moveDay에서 period를 day로 맞추면 됨)
//  · 오늘 = day를 오늘로. 일간 탭을 바로 누르면 마지막으로 본 날 (처음은 오늘)
//  · 아직 오지 않은 날은 열지 않음 (다음은 오늘까지)
import { addDays, dateParts, startOfDay } from '@/lib/format';

import { dateOf, daysInMonth, shiftMonth } from './calendar';

export type RecordView = 'month' | 'week' | 'day';

export type RecordNav = { view: RecordView; period: Date; day: Date };

// 처음 화면은 주간 (D28 열림 — 지금 코드 그대로)
export function initialNav(today: Date): RecordNav {
  return { view: 'week', period: today, day: startOfDay(today) };
}

export function selectView(nav: RecordNav, view: RecordView): RecordNav {
  return { ...nav, view };
}

// 앞뒤 달 — 같은 날짜로, 그 달에 없으면 말일로 (31일 → 30일)
export function moveMonth(nav: RecordNav, delta: number): RecordNav {
  const { year, month, day } = dateParts(nav.period);
  const next = shiftMonth(year, month, delta);
  return { ...nav, period: dateOf(next.year, next.month, Math.min(day, daysInMonth(next.year, next.month))) };
}

// 앞뒤 주 — 7일씩
export function moveWeek(nav: RecordNav, delta: number): RecordNav {
  return { ...nav, period: addDays(nav.period, 7 * delta) };
}

// 월간 · 주간에서 날짜를 눌렀을 때 — 그 날의 일간으로
export function openDay(nav: RecordNav, date: Date): RecordNav {
  return { ...nav, view: 'day', day: startOfDay(date) };
}

// 일간 이전(−1) · 다음(+1) — 오늘 뒤로는 못 감
export function moveDay(nav: RecordNav, delta: number, today: Date): RecordNav {
  const day = addDays(nav.day, delta);
  return day.getTime() > startOfDay(today).getTime() ? nav : { ...nav, day };
}

// 일간 "오늘"
export function goToday(nav: RecordNav, today: Date): RecordNav {
  return { ...nav, day: startOfDay(today) };
}

export function canMoveNextDay(nav: RecordNav, today: Date) {
  return nav.day.getTime() < startOfDay(today).getTime();
}
