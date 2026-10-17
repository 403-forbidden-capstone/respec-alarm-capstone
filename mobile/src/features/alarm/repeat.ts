// 일정 반복 (H05 · D44) — 요일 집합 ⇄ 반복 규칙 글자(RRULE, appointments.recurrence_rule) · 화면 글자
// 순수 계산만 — 단위 테스트는 __tests__/repeat.test.ts
// 다음 회차를 만드는 규칙(몇 회차까지)은 D4(열림)라 여기에 없음. 이 파일은 "무슨 요일에 반복하는지"만 다룸
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

const BYDAY: Record<Weekday, string> = { 월: 'MO', 화: 'TU', 수: 'WE', 목: 'TH', 금: 'FR', 토: 'SA', 일: 'SU' };
const FROM_BYDAY = Object.fromEntries(Object.entries(BYDAY).map(([day, code]) => [code, day])) as Record<string, Weekday>;

export const EVERY_DAY: readonly Weekday[] = WEEKDAYS;
export const WEEKDAYS_ONLY: readonly Weekday[] = ['월', '화', '수', '목', '금'];

// 월요일부터 순서대로, 겹친 요일은 하나로
export const sortDays = (days: readonly Weekday[]): Weekday[] => WEEKDAYS.filter((day) => days.includes(day));

export const sameDays = (a: readonly Weekday[], b: readonly Weekday[]) => sortDays(a).join() === sortDays(b).join();

// 요일 칩을 누름 — 켜져 있으면 끄고, 꺼져 있으면 켬
export function toggleWeekday(days: readonly Weekday[], day: Weekday): Weekday[] {
  return sortDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
}

// 요일 → RRULE. 요일이 없으면 반복 없음(null), 7일 모두면 매일(FREQ=DAILY)
//   [월, 수] → FREQ=WEEKLY;BYDAY=MO,WE
export function repeatToRrule(days: readonly Weekday[]): string | null {
  const sorted = sortDays(days);
  if (!sorted.length) return null;
  if (sorted.length === WEEKDAYS.length) return 'FREQ=DAILY';
  return `FREQ=WEEKLY;BYDAY=${sorted.map((day) => BYDAY[day]).join(',')}`;
}

// RRULE → 요일. 읽지 못하는 글자 · 요일이 없는 주간 규칙(BYDAY 없음)은 반복 없음으로 봄
export function rruleToRepeat(rule: string | null | undefined): Weekday[] {
  if (!rule) return [];
  const parts = new Map(
    rule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((part) => {
        const [key, value] = part.split('=');
        return [key.toUpperCase(), value] as [string, string | undefined];
      }),
  );
  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq === 'DAILY') return [...EVERY_DAY];
  if (freq !== 'WEEKLY') return [];
  const codes = (parts.get('BYDAY') ?? '').toUpperCase().split(',');
  return sortDays(codes.flatMap((code) => (FROM_BYDAY[code] ? [FROM_BYDAY[code]] : [])));
}

// 화면 글자 — 반복 없음 · 매일 · 평일 · 매주 목요일 · 매주 월 · 수
export function repeatLabel(days: readonly Weekday[]): string {
  const sorted = sortDays(days);
  if (!sorted.length) return '반복 없음';
  if (sameDays(sorted, EVERY_DAY)) return '매일';
  if (sameDays(sorted, WEEKDAYS_ONLY)) return '평일';
  if (sorted.length === 1) return `매주 ${sorted[0]}요일`;
  return `매주 ${sorted.join(' · ')}`;
}
