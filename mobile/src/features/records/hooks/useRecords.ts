import { getDay, getMonth, getWeek, getWeekAiSummary, recordToday, weekEmptyText } from '@/features/records/api';
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

// 주간 AI 요약 — 일기가 있는 주에서만 부름(부르는 쪽이 journalDays > 0일 때만 그림). 그 주 일기 지문(journalKey)이 바뀌면 다시 읽음 —
//   당겨서 새로고침으로 주간 기록을 다시 읽었을 때 일수가 같아도 글만 고쳤으면 다시 읽음. 화면에 들어올 때도 다시 읽음(useLoad) — 기록이 그대로면 서버가 모델을 다시 안 부름
export function useWeekAiSummary(period: Date, journalKey: string) {
  return useLoadOn(() => getWeekAiSummary(period), `${dayKey(weekStart(period))}:${journalKey}`);
}

export function useDayRecord(day: Date) {
  return useLoadOn(() => getDay(day), dayKey(day));
}

// 기록 기준 오늘 — 가짜 모드는 시나리오 날짜(5월 22일), 실데이터는 지금
export function useRecordToday() {
  return recordToday();
}
