// DB 행 ↔ 루틴 · 일기 화면 타입 바꾸기 — 순수 함수만 (시험: __tests__/map.test.ts). 쿼리는 real.ts
//
// 루틴 저장 모양(D29 열림): routines에 시작 시각 칸이 없고 steps · repeat_days 형식이 정해지지 않았음. 그래서 이 파일에서만 정하고, 정해지면 이 파일만 고침
//   · repeat_days  'MON,WED,FRI' — 월~일 = MON TUE WED THU FRI SAT SUN, 3일 이상 이어지면 'MON~FRI' (DB 기본값 모양). 읽을 땐 둘 다 읽음
//   · steps        [{ order, title, offset, minutes, is_alarm }] — order 1부터, offset = 그 단계가 시작하는 시각(0시부터 분, 자정을 넘으면 1440 이상),
//                  첫 단계의 offset이 루틴 시작 시각. minutes = 걸리는 시간 (4장 steps에 없는 칸 — 마지막 단계의 길이를 저장할 곳이 없어서). type은 값 목록이 없어 안 씀
//                  step_order(alarms) = order
//   · 읽을 땐 빠진 칸을 너그럽게 채움 (minutes가 없으면 다음 단계 offset과의 간격)
import { addDays, addMinutes, dateParts, dayKey, startOfDay } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';
import type { TimelineRow } from '@/features/records/types';
import { parseDayParam } from '@/features/alarm/schedule';
import type { Json, Tables } from '@/types/database';

import { nextStart } from './draft';
import type { EveningRoutine, Journal, JournalFact, Routine, RoutineProgress, RoutineStep, Todo } from './types';

// ---------------------------------------------------------------------------
// 반복 요일
// ---------------------------------------------------------------------------

const CODE: Record<Weekday, string> = { 월: 'MON', 화: 'TUE', 수: 'WED', 목: 'THU', 금: 'FRI', 토: 'SAT', 일: 'SUN' };
const CODES = WEEKDAYS.map((d) => CODE[d]); // 월요일부터

// 'MON~FRI' · 'MON,WED,FRI' · 'SAT~MON'(일요일을 넘는 범위) → 요일 목록 (월요일부터). 모르는 글자는 건너뜀
export function parseRepeatDays(text: string | null | undefined): Weekday[] {
  const picked = new Set<number>();
  for (const part of (text ?? '').toUpperCase().split(/[,\s]+/)) {
    const range = /^([A-Z]{3})[~-]([A-Z]{3})$/.exec(part);
    if (range) {
      const from = CODES.indexOf(range[1]);
      const to = CODES.indexOf(range[2]);
      if (from < 0 || to < 0) continue;
      for (let i = from; ; i = (i + 1) % 7) {
        picked.add(i);
        if (i === to) break;
      }
    } else if (CODES.includes(part)) {
      picked.add(CODES.indexOf(part));
    }
  }
  return WEEKDAYS.filter((_, i) => picked.has(i));
}

// 요일 목록 → 저장 글자. 3일 이상 이어진 구간은 'MON~FRI'로, 나머지는 쉼표로 (varchar(20) 안에 들어감)
export function formatRepeatDays(days: readonly Weekday[]): string {
  const picked = WEEKDAYS.map((d) => days.includes(d));
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (!picked[i]) continue;
    let end = i;
    while (end + 1 < 7 && picked[end + 1]) end++;
    if (end - i >= 2) parts.push(`${CODES[i]}~${CODES[end]}`);
    else for (let k = i; k <= end; k++) parts.push(CODES[k]);
    i = end;
  }
  return parts.join(',');
}

/** 오늘(날짜)의 요일 */
export const weekdayOf = (date: Date): Weekday => WEEKDAYS[(dateParts(date).weekdayIndex + 6) % 7];

// ---------------------------------------------------------------------------
// 루틴 ↔ routines 한 줄
// ---------------------------------------------------------------------------

// 시작 시각이 없는 루틴(일기 제안에서 만든 빈 초안 · 읽을 수 없는 steps)에 쓰는 값 — 목업의 루틴 제안 시각 (수요일 밤 9:30)
export const DEFAULT_START_MINUTE = 21 * 60 + 30;
const DEFAULT_STEP_MINUTES = 5;
const BLANK_STEP_NAME = '새 단계'; // draft.ts addStep과 같은 이름

export type RoutineRow = Pick<Tables<'routines'>, 'routine_id' | 'title' | 'goal' | 'repeat_days' | 'steps' | 'is_active'> & {
  daily_journals: { record_date: string } | null; // 이 루틴을 제안한 일기
};

const isRecord = (v: unknown): v is Record<string, Json | undefined> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// steps(JSON) → 시작 시각 + 단계. 하나도 읽을 수 없으면 null
export function parseSteps(json: Json): { startMinute: number; steps: RoutineStep[] } | null {
  if (!Array.isArray(json)) return null;
  const items = json
    .map((raw, index) => ({ raw, index }))
    .filter((x): x is { raw: Record<string, Json | undefined>; index: number } => isRecord(x.raw))
    // order가 있으면 그 순서로, 없으면 들어 있는 순서
    .sort((a, b) => (finite(a.raw.order) && finite(b.raw.order) ? a.raw.order - b.raw.order : a.index - b.index))
    .map((x) => x.raw);
  if (!items.length) return null;
  const startMinute = finite(items[0].offset) ? Math.round(items[0].offset) : DEFAULT_START_MINUTE;
  const steps = items.map((raw, i): RoutineStep => {
    const next = items[i + 1]?.offset;
    const gap = finite(raw.offset) && finite(next) ? Math.round(next - raw.offset) : 0;
    const minutes = finite(raw.minutes) && raw.minutes > 0 ? Math.round(raw.minutes) : gap > 0 ? gap : DEFAULT_STEP_MINUTES;
    const name = typeof raw.title === 'string' ? raw.title.trim() : '';
    return { id: `s${i + 1}`, name: name || BLANK_STEP_NAME, minutes, alarm: raw.is_alarm === true };
  });
  return { startMinute, steps };
}

// 단계 → steps(JSON). 시작 시각에 앞 단계들의 걸리는 시간을 차례로 더해 offset을 채움 (draft.ts stepTimes와 같은 규칙)
export function stepsToJson(startMinute: number, steps: readonly RoutineStep[]): Json[] {
  let at = startMinute;
  return steps.map((s, i) => {
    const row = { order: i + 1, title: s.name, offset: at, minutes: s.minutes, is_alarm: s.alarm };
    at += s.minutes;
    return row;
  });
}

// routines 한 줄 → 화면 루틴. steps를 못 읽으면 null (그 루틴은 목록에서 빠짐)
export function toRoutine(row: RoutineRow): Routine | null {
  const parsed = parseSteps(row.steps);
  if (!parsed) return null;
  return {
    id: row.routine_id,
    title: row.title,
    goal: row.goal ?? '',
    days: parseRepeatDays(row.repeat_days),
    startMinute: parsed.startMinute,
    steps: parsed.steps,
    active: row.is_active,
    sourceJournal: row.daily_journals?.record_date ?? null,
  };
}

// 저장할 칸 (routines Insert · Update 공통) — varchar 길이(title 60 · goal 200)에 맞춰 자름
export function routineFields(routine: Routine) {
  return {
    title: routine.title.trim().slice(0, 60) || '새 루틴',
    goal: routine.goal.trim() ? routine.goal.trim().slice(0, 200) : null,
    repeat_days: formatRepeatDays(routine.days),
    steps: stepsToJson(routine.startMinute, routine.steps),
    is_active: routine.active,
  };
}

export function toEveningRoutine(routine: Routine): EveningRoutine | null {
  if (!routine.id) return null;
  return { id: routine.id, title: routine.title, days: [...routine.days], startMinute: routine.startMinute, stepCount: routine.steps.length };
}

// 일기의 루틴 제안에서 "루틴 만들기"를 누른 빈 초안 (A04 /routine/new) — 초안을 저장하는 자리가 없어서(D30 열림) 제안 글의 첫 줄을 이름으로만 씀
//   요일은 직접 고르게 비워 둠 (고르기 전엔 저장 버튼이 꺼져 있음)
export function blankRoutine(sourceJournal: string | null, suggestion: string | null): Routine {
  return {
    id: null,
    title: splitSuggestion(suggestion).title.slice(0, 60) || '새 루틴',
    goal: '',
    days: [],
    startMinute: DEFAULT_START_MINUTE,
    steps: [{ id: 's1', name: BLANK_STEP_NAME, minutes: DEFAULT_STEP_MINUTES, alarm: false }],
    active: true,
    sourceJournal,
  };
}

// ---------------------------------------------------------------------------
// 오늘 루틴 진행 (H01) — 단계 알람(alarms.routine_id · step_order)에 오늘 쌓인 ACKNOWLEDGED로 셈
// ---------------------------------------------------------------------------

// 오늘 루틴 하나 — 켜져 있고 오늘 요일이 든 것 중 저녁 전에 시작하는 것(저녁 루틴은 저녁 홈 카드로), 가장 일찍 시작하는 것
export function pickTodayRoutine(routines: readonly Routine[], weekday: Weekday, eveningStartMinute: number): Routine | null {
  return (
    routines
      .filter((r) => r.active && r.days.includes(weekday) && r.startMinute < eveningStartMinute)
      .sort((a, b) => a.startMinute - b.startMinute)[0] ?? null
  );
}

// 끝낸 단계 수 = 오늘 확인한 단계 중 가장 뒤 단계 (알람이 없는 단계는 확인할 자리가 없어 뒤 단계를 확인하면 같이 끝난 것으로 봄)
export function routineProgress(routine: Routine, ackedStepOrders: readonly number[]): RoutineProgress | null {
  if (!routine.id) return null;
  const done = ackedStepOrders.reduce((max, order) => (order >= 1 && order <= routine.steps.length ? Math.max(max, order) : max), 0);
  return { id: routine.id, title: routine.title, steps: routine.steps.map((s) => s.name), done };
}

// 다음에 확인할 단계 — done 다음부터 처음 나오는 알람 있는 단계 (step_order). 없으면 null
export function nextAckStep(routine: Routine, done: number): number | null {
  const index = routine.steps.findIndex((s, i) => i >= done && s.alarm);
  return index < 0 ? null : index + 1;
}

// 단계 알람이 처음 울릴 날 · 시각 — 켜 둔 단계 알람마다 (nextStart: 시작 시각이 지났으면 다음 요일). 요일이 없으면 없음
export function planRoutineAlarms(routine: Pick<Routine, 'days' | 'startMinute' | 'steps'>, from: Date): { stepOrder: number; at: Date }[] {
  const next = nextStart(routine, from);
  if (!next) return [];
  const base = addDays(startOfDay(from), next.daysAhead);
  let minute = routine.startMinute;
  return routine.steps.flatMap((s, i) => {
    const at = addMinutes(base, minute);
    minute += s.minutes;
    return s.alarm ? [{ stepOrder: i + 1, at }] : [];
  });
}

// ---------------------------------------------------------------------------
// 준비물
// ---------------------------------------------------------------------------

export type TodoRow = Pick<Tables<'todos'>, 'todo_id' | 'title' | 'is_done'>;
export const toTodo = (row: TodoRow): Todo => ({ id: row.todo_id, title: row.title, done: row.is_done });

// ---------------------------------------------------------------------------
// 일기
// ---------------------------------------------------------------------------

export type JournalRow = Pick<
  Tables<'daily_journals'>,
  'journal_id' | 'record_date' | 'ai_summary' | 'edited_summary' | 'is_edited' | 'coaching_insight' | 'encouragement' | 'routine_suggestion' | 'suggestion_status'
>;

// 루틴 제안 글 → 제목 · 설명. 글 하나뿐이라(D30 열림) 첫 줄을 제목, 나머지를 설명으로. 비었으면 제안 없음(제목이 빈 글자)
export function splitSuggestion(text: string | null | undefined): { title: string; summary: string } {
  const lines = (text ?? '').split('\n').map((l) => l.trim());
  const first = lines.findIndex(Boolean);
  if (first < 0) return { title: '', summary: '' };
  return { title: lines[first], summary: lines.slice(first + 1).filter(Boolean).join(' ') };
}

// 일기에 넣는 사실 — 기상 · 출발 · 도착 · 미루기 같은 기록 (울림 · 해제 같은 자동 기록은 뺌). 가짜 데이터(mocks/ai.ts)와 같은 규칙
const FACT = /^(기상 확인|집 출발|도착|재알람|일정 저장|준비물 저장)|미루기/;
export const journalFacts = (rows: readonly TimelineRow[]): JournalFact[] => rows.filter((r) => FACT.test(r.label)).map(({ at, label, source }) => ({ at, label, source }));

export function toJournal(row: JournalRow, facts: JournalFact[], routineId: string | null): Journal | null {
  const date = parseDayParam(row.record_date);
  if (!date) return null;
  const aiText = row.ai_summary ?? '';
  const suggestion = splitSuggestion(row.routine_suggestion);
  return {
    recordDate: dayKey(date),
    date,
    aiText,
    // 고쳤을 때만 고친 글을 보여 줌 (edited_summary는 고쳤을 때만 저장)
    text: row.is_edited && row.edited_summary != null ? row.edited_summary : aiText,
    edited: row.is_edited,
    facts,
    coaching: row.coaching_insight ?? '',
    encouragement: row.encouragement ?? '',
    suggestion: { title: suggestion.title, reason: '', summary: suggestion.summary, status: row.suggestion_status },
    routineId,
  };
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

