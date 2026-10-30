// 폰 캘린더에서 가져오기(D66-1 D) 규칙 — 앞으로 2주 일정에서 "매주 반복되는 수업 후보"를 찾음. AI 없음, 폰 안에서만 처리 (시험: __tests__/calendar.test.ts)
// 기준 문서: 상세설계서 7.13.10 캘린더 가져오기(M8) — 자동 등록은 하지 않고 확인 화면에서 사용자가 확인
import { addDays, dateParts, minuteOfDay, startOfDay } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';

import type { ImportBatch, ImportedClass } from './timetableImport';

export const WINDOW_DAYS = 14;

// 캘린더 앱이 주는 일정 한 건 (expo-calendar의 ExpoCalendarEvent에서 쓰는 칸만). 반복 일정은 날짜마다 한 건씩 와서 recurrenceRule이 같이 붙음
export type CalendarEventLike = {
  title: string;
  startDate: string | Date;
  endDate: string | Date;
  allDay?: boolean;
  location?: string | null;
  recurrenceRule?: { frequency?: string; interval?: number } | null;
};

export type CalendarChoice = { id: string; title: string; source: string };

// 읽을 기간 — 오늘 0시부터 14일 (오늘 수업이 이미 지났어도 요일을 알 수 있게)
export function windowOf(now: Date): { start: Date; end: Date } {
  const start = startOfDay(now);
  return { start, end: addDays(start, WINDOW_DAYS) };
}

const at = (v: string | Date) => (v instanceof Date ? v : new Date(v));

// 매주 한 번 반복하는 규칙인가 — 캘린더가 알려 준 주간 규칙(간격 1). 'weekly'는 expo-calendar Frequency.WEEKLY 값
const isWeeklyRule = (e: CalendarEventLike) => e.recurrenceRule?.frequency?.toLowerCase() === 'weekly' && (e.recurrenceRule.interval ?? 1) === 1;

const ORDER: readonly Weekday[] = ['월', '화', '수', '목', '금', '토', '일'];

type Group = { title: string; startMinutes: number; endMinutes: number; place: string | null; weekdays: Set<Weekday>; perDay: Map<Weekday, number>; weekly: boolean };

// 일정 → 수업 후보. 같은 이름 · 시각 · 장소인 건을 한 줄로 묶고 요일을 모음 ("월·수 10:30"은 한 줄).
// 후보 조건(둘 중 하나): ① 캘린더가 주간 반복 규칙을 붙인 일정 ② 2주 안에 같은 요일 · 같은 시각으로 두 번 이상 있는 일정 (규칙 없이 복사해 둔 반복)
// 뺌: 하루 종일 일정 · 이름이 빈 일정 · 끝이 시작보다 늦지 않은 일정 · 자정을 넘는 일정(수업 아님)
// 장소: 일정의 위치 글자 그대로, 없으면 null — 7.13.10은 장소 있는 일정만 후보로 하지만 확인 화면이 있고 학교 위치를 따로 정하므로 장소 없는 일정도 후보로 둠 (작성자 판단)
export function candidatesFromEvents(events: readonly CalendarEventLike[]): ImportedClass[] {
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.allDay) continue;
    const title = e.title.replace(/\s+/g, ' ').trim();
    const start = at(e.startDate);
    const end = at(e.endDate);
    if (!title || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const startMinutes = minuteOfDay(start);
    const endMinutes = minuteOfDay(end);
    if (dateParts(start).day !== dateParts(end).day || endMinutes <= startMinutes) continue; // 자정을 넘거나 끝이 시작보다 빠름
    const place = e.location?.replace(/\s+/g, ' ').trim() || null;
    const weekday = ORDER[(dateParts(start).weekdayIndex + 6) % 7]; // 0 = 일요일 → 월요일부터 순서로
    const key = `${title}|${startMinutes}|${endMinutes}|${place ?? ''}`;
    const g = groups.get(key) ?? { title, startMinutes, endMinutes, place, weekdays: new Set<Weekday>(), perDay: new Map<Weekday, number>(), weekly: false };
    g.weekdays.add(weekday);
    g.perDay.set(weekday, (g.perDay.get(weekday) ?? 0) + 1);
    g.weekly ||= isWeeklyRule(e);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.weekly || [...g.perDay.values()].some((n) => n >= 2))
    .map((g) => ({ title: g.title, weekdays: ORDER.filter((d) => g.weekdays.has(d)), startMinutes: g.startMinutes, endMinutes: g.endMinutes, place: g.place }))
    .sort((a, b) => a.startMinutes - b.startMinutes || a.title.localeCompare(b.title));
}

export function toBatch(events: readonly CalendarEventLike[]): ImportBatch {
  return { source: 'calendar', classes: candidatesFromEvents(events) };
}
