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

export type WeekDay = {
  date: Date;
  weekday: string; // 월
  day: number;
  isToday: boolean;
  isFuture: boolean;
  recorded: boolean; // 그날 기록이 있으면 점
};

// 주간 실행 흐름 막대 한 줄 — 눌러서 그날 일간으로 (D48, 날짜 칩과 같음)
export type WeekBar = {
  label: string; // 월 19
  score: number; // 0~100
  date: Date;
  isToday: boolean;
  isFuture: boolean; // 막대는 기록이 있는 날만이라 지금은 늘 false — 날짜 칩과 같은 누름 처리를 쓰려고 둠
};

export type WeekSummary = {
  averageWake: Date;
  averageText: string; // 지난주보다 2분 빨라요
  goalRate: number; // 0~100
  goalText: string; // 이번 주 3/3일
  bars: WeekBar[];
  todayPending: boolean; // 오늘 기록은 기상 확인 뒤에 더해짐
};

// 주간 AI 요약 — 그 주 하루 일기 글을 모아 만든 글 (서버 weekly-summary). 기상 기록과 상관없이 일기가 하루라도 있으면 있음
export type WeekAiSummary = {
  text: string;
  dayCount: number; // 반영된 기록 일수
  period: string; // 대상 기간 — 5월 19일 — 25일
  stale: boolean; // 최근에 바뀐 기록을 아직 반영하지 못한 저장된 글
};

export type WeekRecord = {
  title: string; // 5월 19일 — 25일
  relative: string; // 이번 주 · 지난주 · 2주 전
  strip: WeekDay[]; // 월 ~ 일
  summary: WeekSummary | null; // 기상 통계 — 점수를 낼 기상 기록이 없는 주는 null
  journalDays: number; // 글이 있는 일기 수 — 0이 아니면 AI 주간 요약을 읽음
  journalKey: string; // 그 주 일기 날짜 · 글 지문 — 바뀌면(새로고침에서 글만 고친 경우 포함) AI 요약을 다시 읽음
};

export type TimelineRow = { at: Date; label: string; source: string; past?: boolean };

export type DayRecord = {
  date: Date;
  isToday: boolean;
  isFuture: boolean; // 아직 오지 않은 날 — 기록 없음
  planned: TimelineRow[]; // 설정한 값 (알람)
  actual: TimelineRow[]; // 실제로 일어난 일
  journalWritten: boolean; // 그날 AI 일기가 있음 (A03로 열기)
};

export type SuggestionStatus = Enums<'alarm_suggestion_status'>; // PENDING · APPLIED · EDITED · IGNORED

// 시각이 아닌 제안 — 말소리 · 배경음 · 진동 (DB alarm_suggestion_type VOICE_TONE · SOUND · INTENSITY). 실데이터에서만 있음
//   시각 제안은 준비 알람 당김(PREPARE_ADVANCE, #484 · 안건 D111) — change 없이 시각 칸을 씀
export type SuggestionChange = {
  kind: Enums<'alarm_suggestion_type'>;
  axis: string; // 말소리 · 배경음 · 진동
  target: string; // 바뀌는 알람 — 5월 22일 (목) 팀 주간회의 · 기상 알람
  current: string; // 지금 값 글자 (차분 · 다정)
  suggested: string; // 제안한 값 글자
  result: string | null; // 적용한 값 글자 (적용 전엔 null)
};

// 알람 조정 제안 (S01 · H01 카드)
export type Suggestion = {
  id: string;
  title: string; // 다음 알람을 10분 앞당겨 볼까요?
  summary: string; // 최근 3번의 준비가 예상보다 오래 걸렸어요.
  reason: string; // 최근 3번의 준비가 예상보다 평균 12분 더 걸렸어요.
  deltas: { label: string; value: string }[]; // 1회 전 +10분 …
  appointment: { id: string; title: string; at: Date };
  minutes: number; // 제안한 준비 알람 앞당김 (분) — 준비 알람을 당기고, 준비 전 활동(기상 → 준비)을 넘는 만큼만 기상도 (안건 D111 1 · 2번)
  currentWake: Date; // 지금(적용 뒤에는 적용 전) 기상 알람
  currentPrepare: Date | null; // 지금(적용 뒤에는 적용 전) 준비 알람 — 준비 알람이 없으면 null
  depart: Date; // 출발 알람 — 약속에 맞춰 정해져서 조정해도 그대로
  bounds: EditBounds; // 직접 고를 수 있는 범위 (D53)
  proposedWake: Date; // 제안(적용 뒤에는 실제로 적용한) 기상 알람 — 준비 전 활동 안이면 지금과 같음
  proposedPrepare: Date | null; // 제안(적용 뒤에는 실제로 적용한) 준비 알람
  status: SuggestionStatus;
  applied: { wake: Date; prepare: Date | null; minutes: number } | null; // 적용한 뒤 시각 · 적용 전보다 일찍(+) 늦게(−)
  // 시각이 아닌 제안이면 있음 — 시각 칸(currentWake · proposedWake · bounds 등)은 대상 알람 시각으로 채워 두고 화면은 안 씀 (appointment.id가 빈 글자면 연결된 일정 없음)
  change?: SuggestionChange;
};

// 직접 고르는 범위 — earlier분 일찍 ~ later분 늦게 (분, 둘 다 0 이상)
export type EditBounds = { earlier: number; later: number };
