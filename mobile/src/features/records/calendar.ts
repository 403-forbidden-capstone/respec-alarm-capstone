// 달력 계산 (R02 월간 · 주간) — 한국 시간 기준, 월요일 시작
// 날짜는 lib/format으로만 읽음. 'YYYY-MM-DD' 글자를 new Date에 넣으면 UTC 0시가 되므로 쓰지 않음
import { addDays, dateParts, formatDateShort, isSameDay, minutesBetween, startOfDay } from '@/lib/format';

const WEEK_MINUTES = 7 * 24 * 60;

// year년 month월 day일 0시 (한국 시간) — UTC 0시는 한국 오전 9시라 같은 날짜로 읽힘. day가 넘치면 다음 달로 넘어감
export function dateOf(year: number, month: number, day: number) {
  return startOfDay(new Date(Date.UTC(year, month - 1, day)));
}

// 그 달 날짜 수
export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 그 달 1일 ~ 말일
export function monthDays(year: number, month: number) {
  return Array.from({ length: daysInMonth(year, month) }, (_, i) => dateOf(year, month, i + 1));
}

// 월요일 시작 달력에서 1일 앞 빈칸 수 (0~6)
export function leadingBlanks(year: number, month: number) {
  return (dateParts(dateOf(year, month, 1)).weekdayIndex + 6) % 7;
}

// 앞뒤 달 — shiftMonth(2025, 1, -1) → 2024년 12월
export function shiftMonth(year: number, month: number, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

// anyDay가 든 주의 월요일 0시
export function weekStart(anyDay: Date) {
  const day = startOfDay(anyDay);
  return addDays(day, -((dateParts(day).weekdayIndex + 6) % 7));
}

// anyDay가 든 주 월요일 ~ 일요일
export function weekDays(anyDay: Date) {
  const start = weekStart(anyDay);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// 달력 칸을 7개씩 줄로 — 앞 빈칸 · 마지막 줄 남는 칸은 null
export function calendarRows<T>(blanks: number, items: readonly T[]): (T | null)[][] {
  const cells: (T | null)[] = [...Array<null>(blanks).fill(null), ...items];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

// 2025년 5월
export function monthTitle(year: number, month: number) {
  return `${year}년 ${month}월`;
}

// 5월 19일 — 25일 · 달이 넘어가면 5월 26일 — 6월 1일
export function weekTitle(anyDay: Date) {
  const start = weekStart(anyDay);
  const a = dateParts(start);
  const b = dateParts(addDays(start, 6));
  return `${a.month}월 ${a.day}일 — ${a.month === b.month ? '' : `${b.month}월 `}${b.day}일`;
}

// 오늘이 든 주 기준 — 이번 주 · 지난주 · 다음 주 · 2주 전 · 3주 뒤
export function weekRelative(anyDay: Date, today: Date) {
  const n = Math.round(minutesBetween(weekStart(today), weekStart(anyDay)) / WEEK_MINUTES);
  if (n === 0) return '이번 주';
  if (n === -1) return '지난주';
  if (n === 1) return '다음 주';
  return n < 0 ? `${-n}주 전` : `${n}주 뒤`;
}

// 알림 · 안내 문장에 쓰는 날 — 오늘 · 내일 · 그 밖은 5월 23일 금
export function dayWord(date: Date, today: Date) {
  if (isSameDay(date, today)) return '오늘';
  if (isSameDay(date, addDays(startOfDay(today), 1))) return '내일';
  return formatDateShort(date);
}
