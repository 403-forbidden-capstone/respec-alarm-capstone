// ⑥ AI 일기 · 루틴 — 이 기능에서 쓰는 타입
import type { Weekday } from '@/lib/weekday';
import type { Enums } from '@/types/database';

// 요일은 일정 반복(H05)과 같이 쓰려고 lib/weekday로 옮김 — 루틴 쪽 이름은 그대로 쓸 수 있게 다시 내보냄
export { WEEKDAYS } from '@/lib/weekday';
export type { Weekday };

// 오늘 루틴 진행 (H01) — 단계를 순서대로 끝냄
export type RoutineProgress = {
  id: string;
  title: string;
  steps: string[];
  done: number; // 끝낸 단계 수
};

// 준비물 (DB todos, todo_type = ITEM)
export type Todo = {
  id: string;
  title: string;
  done: boolean;
};

// 루틴 단계 (routines.steps 한 칸) — 시각은 첫 단계 시각부터 걸리는 시간을 차례로 더해 셈
export type RoutineStep = {
  id: string; // 순서를 바꿀 때 쓰는 이름표
  name: string;
  minutes: number; // 걸리는 시간
  alarm: boolean; // 이 단계 시작에 알람 (alarms.routine_id · step_order)
};

// 루틴 (A04) — 일기의 루틴 제안으로 만든 초안이면 id가 null (저장 전)
export type Routine = {
  id: string | null;
  title: string;
  goal: string;
  days: Weekday[]; // 반복 요일, 월요일부터 순서대로
  startMinute: number; // 첫 단계 시각 (0시부터 분, 1290 = 21:30)
  steps: RoutineStep[];
  active: boolean;
  sourceJournal: string | null; // 이 루틴을 제안한 일기 날짜 (2025-05-22)
  sourceSuggestion?: string | null; // 이 루틴을 만든 루틴 제안 (routine_suggestions, 안건 D114) — 저장하면 그 제안이 "받아들임"
};

// 루틴 제안 (안건 D114 · D30 B, routine_suggestions) — 18:00 서버가 기록으로 만든 초안 (calc/routine.ts)
export type RoutineSuggestionStep = { name: string; minutes: number; alarm: boolean; offsetFromWake: number | null; at: string | null };
export type RoutineSuggestion = {
  id: string;
  cause: 'OVERSLEEP' | 'LATE_START' | 'NIGHT_PREP'; // 늦잠 · 다시 잠듦 / 준비를 늦게 시작 / 전날 준비 부족
  title: string; // 일어나자마자 2단계
  reason: string; // 최근 아침 7번 중 4번, 기상 알람 뒤 평균 18분 만에 일어났어요
  draft: { goal: string; days: number[]; steps: RoutineSuggestionStep[] }; // days 0 일 ~ 6 토, 단계 시각은 기상 기준 분(D29) · 밤 루틴만 고정 시각
};

// 홈 저녁 "저녁 루틴" 카드 (H01)
export type EveningRoutine = { id: string; title: string; days: Weekday[]; startMinute: number; stepCount: number };

export type ApplyStatus = Enums<'apply_status'>; // PENDING · APPLIED · REJECTED

// 오늘의 사실 한 줄 — 출처 우선순위 직접 입력 > 자동 > 알림 > AI
export type JournalFact = { at: Date; label: string; source: string };

// 하루 기록 · 일기 (A03, daily_journals)
export type Journal = {
  recordDate: string; // 2025-05-22
  date: Date; // 그날 0시
  aiText: string; // AI가 쓴 글 (ai_summary)
  text: string; // 보여 줄 글 — 고쳤으면 고친 글 (edited_summary)
  edited: boolean;
  facts: JournalFact[];
  coaching: string;
  encouragement: string;
  suggestion: {
    title: string; // 회의 전날 준비 (빈 글자면 루틴 제안이 없는 일기 — 화면이 제안 카드를 접음)
    reason: string; // 같은 문제가 최근 7일 중 3일 (실데이터는 DB에 칸이 없어 빈 글자 — D30 열림)
    summary: string; // 수요일 밤 9:30부터 3단계 · 아침 알람은 앞당기지 않아요
    status: ApplyStatus; // 루틴을 저장하면 APPLIED, 괜찮아요 = REJECTED
  };
  routineId: string | null; // 이 제안으로 만든 루틴 (A04로 다시 열 때). 아직 안 만들었으면 null
};
