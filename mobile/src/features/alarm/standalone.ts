// 기본 알람(일정 없는 알람, D46 · #588) 입력 계산 — 알람 탭 "+ 새 알람" 시트
// 순수 계산만 — 단위 테스트는 __tests__/standalone.test.ts. 저장은 api.ts createStandaloneAlarm
// 날짜 칸이 없어 시각 · 반복 요일만 고름 → 지금 뒤로 처음 오는 그 시각이 첫 회차. 다음 회차는 서버(alarm-roll)가 만듦
import { addDays, addMinutes, dateParts, startOfDay } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

const HOUR_MS = 60 * 60_000;
const weekdayOf = (date: Date): Weekday => WEEKDAYS[(dateParts(date).weekdayIndex + 6) % 7]; // 0 = 일요일 → 월요일부터

// 처음 보여 줄 시각 — 지금 다음 정각 (오후 2:13 → 오후 3:00). 한국 시간은 UTC와 정시 단위로 어긋나 UTC 정각 = 한국 정각
export function defaultRingTime(current: Date): Date {
  return new Date((Math.floor(current.getTime() / HOUR_MS) + 1) * HOUR_MS);
}

// 첫 울림 — 고른 시각(0시부터 분)이 지금보다 뒤인 첫날. 반복 요일이 있으면 그 요일 중에서
//   반복 없음: 오늘 그 시각이 지났으면 내일
//   평일 · 토요일 오전: 다음 월요일
export function firstRingAt(minuteOfDay: number, days: readonly Weekday[], current: Date): Date {
  const today = startOfDay(current);
  for (let i = 0; i <= 7; i += 1) {
    const at = addMinutes(addDays(today, i), minuteOfDay);
    if (at.getTime() > current.getTime() && (!days.length || days.includes(weekdayOf(at)))) return at;
  }
  return addMinutes(addDays(today, 1), minuteOfDay); // 요일이 하나라도 있으면 7일 안에 나오므로 닿지 않음
}
