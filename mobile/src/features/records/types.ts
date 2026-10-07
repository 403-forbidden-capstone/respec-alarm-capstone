// ④ 캘린더 · 하루 기록 — 이 기능에서 쓰는 타입
import type { Enums } from '@/types/database';

export type DayMark = 'done' | 'partial' | 'none'; // 기록 완료 · 일부 기록 · 없음

export type MonthDay = {
  date: Date;
  day: number;
  mark: DayMark;
  isToday: boolean;
  isFuture: boolean;
};

export type MonthRecord = {
  title: string; // 2025년 5월
  leadingBlanks: number; // 1일 앞 빈칸 (월요일 시작)
  days: MonthDay[];
  today: { date: Date; eventCount: number; journalWritten: boolean };
};

export type WeekRecord = {
  title: string; // 5월 19일 — 25일
  strip: { date: Date; weekday: string; day: number; isToday: boolean; isFuture: boolean }[];
  averageWake: Date;
  averageText: string; // 지난주보다 2분 빨라요
  goalRate: number; // 0~100
  goalText: string; // 이번 주 3/3일
  bars: { label: string; score: number }[]; // 월 19 · 76
  todayPending: boolean; // 오늘 기록은 기상 확인 뒤에 더해짐
  coaching: string;
};

export type TimelineRow = { at: Date; label: string; source: string; past?: boolean };

export type DayRecord = {
  date: Date;
  planned: TimelineRow[]; // 설정한 값 (알람)
  actual: TimelineRow[]; // 실제로 일어난 일
};

export type SuggestionStatus = Enums<'alarm_suggestion_status'>; // PENDING · APPLIED · EDITED · IGNORED

// 알람 조정 제안 (S01 · H01 카드)
export type Suggestion = {
  id: string;
  title: string; // 다음 알람을 10분 앞당겨 볼까요?
  summary: string; // 최근 3번의 준비가 예상보다 오래 걸렸어요.
  reason: string; // 최근 3번의 준비가 예상보다 평균 12분 더 걸렸어요.
  deltas: { label: string; value: string }[]; // 1회 전 +10분 …
  appointment: { id: string; title: string; at: Date };
  minutes: number; // 제안한 앞당김 (분)
  currentWake: Date; // 지금(적용 뒤에는 적용 전) 기상 알람
  proposedWake: Date; // 제안(적용 뒤에는 실제로 적용한) 기상 알람
  status: SuggestionStatus;
  applied: { wake: Date; prepare: Date | null } | null; // 적용한 뒤 시각
};
