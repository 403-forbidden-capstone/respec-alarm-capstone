// 학교 시간표 화면(/timetable)의 순수 함수 — 일정 목록에서 매주 반복하는 일정만 골라 요일 · 시각 순으로 (시험: __tests__/timetableList.test.ts)
//   수업인지 따로 적는 DB 칸이 없어 반복 일정은 모두 보임 (existingApi와 같은 판단, 11/2 지형님 결정)
import { repeatLabel, rruleToRepeat, sortDays } from '@/features/alarm/repeat';
import type { Appointment } from '@/features/alarm/types';
import { formatTime, minuteOfDay } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

export type ClassSeries = {
  id: string; // 지금 이후 가장 가까운 회차의 일정 id — 지우기(following)가 이 회차부터 뒤를 모두 지움
  title: string;
  days: Weekday[];
  at: Date;
  place: string;
  canDelete: boolean; // 남이 만든 공동 약속이면 false (N6)
};

// listAppointments(묶음당 회차 하나) → 반복 일정만, 첫 요일 · 시각 · 제목 순
export function classSeriesOf(list: readonly Appointment[]): ClassSeries[] {
  return list
    .filter((a) => !a.standalone)
    .map((a) => ({ id: a.id, title: a.title, days: sortDays(rruleToRepeat(a.recurrenceRule)), at: a.at, place: a.place, canDelete: a.canEdit !== false }))
    .filter((s) => s.days.length > 0)
    .sort((x, y) => WEEKDAYS.indexOf(x.days[0]) - WEEKDAYS.indexOf(y.days[0]) || minuteOfDay(x.at) - minuteOfDay(y.at) || x.title.localeCompare(y.title));
}

// 줄 아래 한 줄 — "매주 월 · 수 · 오전 10:30 · 공학관"
export function seriesLine(s: ClassSeries): string {
  return [repeatLabel(s.days), formatTime(s.at), s.place].filter(Boolean).join(' · ');
}
