import { getDay, getMonth, getWeek, recordToday, weekEmptyText } from '@/features/records/api';
import { weekStart } from '@/features/records/calendar';
import { dayKey } from '@/lib/format';

import { useLoadOn } from './useLoadOn';

// 나의 기록(R02) 구역이 읽는 값 — 부품(components/RecordsSection)은 api.ts를 부르지 않고 이 hooks로 읽음 (CLAUDE.md 화면 · 부품 규칙)
// 기간이 바뀌면 앞 내용을 둔 채 다시 읽음 (useLoadOn)

export function useMonthRecord(year: number, month: number) {
  return useLoadOn(() => getMonth(year, month), `${year}-${month}`);
}

// emptyText = 이번 주에 기록이 없을 때 문구 (없으면 null)
export function useWeekRecord(period: Date) {
  const result = useLoadOn(() => getWeek(period), dayKey(weekStart(period)));
  return { ...result, emptyText: result.data ? weekEmptyText(result.data) : null };
}

export function useDayRecord(day: Date) {
  return useLoadOn(() => getDay(day), dayKey(day));
}

// 기록 기준 오늘 — 가짜 모드는 시나리오 날짜(5월 22일), 실데이터는 지금
export function useRecordToday() {
  return recordToday();
}
