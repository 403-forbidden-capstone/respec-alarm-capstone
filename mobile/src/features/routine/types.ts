// ⑥ AI 일기 · 루틴 — 이 기능에서 쓰는 타입
import type { Enums } from '@/types/database';

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

export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const; // 월요일 시작
export type Weekday = (typeof WEEKDAYS)[number];

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
    title: string; // 회의 전날 준비
    reason: string; // 같은 문제가 최근 7일 중 3일
    summary: string; // 수요일 밤 9:30부터 3단계 · 아침 알람은 앞당기지 않아요
    status: ApplyStatus; // 루틴을 저장하면 APPLIED, 괜찮아요 = REJECTED
  };
  routineId: string | null; // 이 제안으로 만든 루틴 (A04로 다시 열 때). 아직 안 만들었으면 null
};
