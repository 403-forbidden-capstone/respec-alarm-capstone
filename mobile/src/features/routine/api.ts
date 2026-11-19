// ⑥ AI 일기 · 루틴 — 데이터 접근은 이 파일에서만 합니다.
// 가짜 데이터(src/mocks)는 그대로 두고, 실데이터 모드면 함수 맨 앞에서 real.ts(Supabase)로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 오늘 루틴 · 내일 준비물 · A03 하루 기록 · A04 루틴 편집)
import { now } from '@/lib/clock';
import { dateParts } from '@/lib/format';
import { isMock } from '@/lib/mode';
import { aiDb, MOCK_ROUTINE_SUGGESTION, MOCK_WAKE_MINUTE, ROUTINE_SUGGESTION, suggestedRoutine } from '@/mocks/ai';
import { db } from '@/mocks/data';

import * as real from './real';
import { suggestionToRoutine } from './suggestion';
import type { EveningRoutine, Journal, Routine, RoutineProgress, RoutineSuggestion, Todo } from './types';

// 오늘 루틴 (H01 아침)
export async function getTodayRoutine(): Promise<RoutineProgress | null> {
  if (!isMock()) return real.getTodayRoutine();
  const r = db.morningRoutine;
  return { id: r.id, title: r.title, steps: [...r.steps], done: r.done };
}

// 다음 단계 완료 — 다 끝낸 뒤 한 번 더 누르면 처음부터
export async function advanceRoutine(id: string): Promise<RoutineProgress | null> {
  if (!isMock()) return real.advanceRoutine(id);
  const r = db.morningRoutine;
  if (r.id !== id) return null;
  r.done = (r.done + 1) % (r.steps.length + 1);
  return getTodayRoutine();
}

// 그날 준비물 (H01 저녁 · 내일 준비물)
export async function listTodos(day: Date): Promise<Todo[]> {
  if (!isMock()) return real.listTodos(day);
  const { day: d } = dateParts(day);
  return db.todos.filter((t) => t.day === d).map(({ id, title, done }) => ({ id, title, done }));
}

export async function toggleTodo(id: string) {
  if (!isMock()) return real.toggleTodo(id);
  const t = db.todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
}

// 하루 기록 · 일기 (A03) — recordDate = daily_journals.record_date (2025-05-22). AI 대화를 마쳐야 생김
export async function getJournal(recordDate: string): Promise<Journal | null> {
  if (!isMock()) return real.getJournal(recordDate);
  const j = aiDb.journals[recordDate];
  if (!j) return null;
  return {
    recordDate,
    date: j.date,
    aiText: j.aiText,
    text: j.text,
    edited: j.edited,
    facts: j.facts.map((f) => ({ ...f })),
    coaching: j.coaching,
    encouragement: j.encouragement,
    suggestion: { ...ROUTINE_SUGGESTION, status: j.suggestion },
    // 같은 일기에서 여러 번 만들었으면 가장 최근 것
    routineId: [...aiDb.routines].reverse().find((r) => r.sourceJournal === recordDate)?.id ?? null,
  };
}

// 일기 고치기 — AI 원본(ai_summary)은 그대로 두고 고친 글(edited_summary)만 바꿈. AI 글과 같으면 고치지 않은 것
export async function editJournal(recordDate: string, text: string) {
  if (!isMock()) return real.editJournal(recordDate, text);
  const j = aiDb.journals[recordDate];
  if (!j) return;
  j.text = text;
  j.edited = text !== j.aiText;
}

// 루틴 제안에 "괜찮아요" (suggestion_status = REJECTED)
export async function declineRoutineSuggestion(recordDate: string) {
  if (!isMock()) return real.declineRoutineSuggestion(recordDate);
  const j = aiDb.journals[recordDate];
  if (j && j.suggestion === 'PENDING') j.suggestion = 'REJECTED';
}

// 홈 저녁 "저녁 루틴" 카드 — A04에서 가장 최근에 저장한 루틴(목업 S.rNight). 저장하면 목록 맨 뒤로 가므로 마지막 것. 없으면 null
export async function getEveningRoutine(): Promise<EveningRoutine | null> {
  if (!isMock()) return real.getEveningRoutine();
  const r = aiDb.routines[aiDb.routines.length - 1];
  if (!r?.id) return null;
  return { id: r.id, title: r.title, days: [...r.days], startMinute: r.startMinute, stepCount: r.steps.length };
}

// 루틴 편집 (A04) — id가 'new'면 일기의 루틴 제안으로 만든 초안(저장 전), 아니면 저장한 루틴
// 기다리는 루틴 제안 (안건 D114) — 저녁 AI 대화 화면 · 오늘 일기의 카드. 없으면 null
export async function getPendingRoutineSuggestion(): Promise<RoutineSuggestion | null> {
  if (!isMock()) return real.getPendingRoutineSuggestion();
  return aiDb.routineSuggestion === 'PENDING' ? structuredClone(MOCK_ROUTINE_SUGGESTION) : null;
}

// 루틴 제안에 "괜찮아요" — 넘김. 같은 원인은 기록이 있는 아침이 3번 더 쌓여야 다시 (D24 C, 서버가 셈)
export async function ignoreRoutineSuggestion(id: string) {
  if (!isMock()) return real.ignoreRoutineSuggestion(id);
  if (id === MOCK_ROUTINE_SUGGESTION.id && aiDb.routineSuggestion === 'PENDING') aiDb.routineSuggestion = 'IGNORED';
}

// sourceSuggestion = 루틴 제안으로 만드는 초안 (/routine/new?suggestion=…), sourceJournal = 일기의 옛 제안 (/routine/new?journal=…)
export async function getRoutine(id: string, sourceJournal?: string, sourceSuggestion?: string): Promise<Routine | null> {
  if (!isMock()) return real.getRoutine(id, sourceJournal, sourceSuggestion);
  if (id === 'new' && sourceSuggestion) {
    return sourceSuggestion === MOCK_ROUTINE_SUGGESTION.id && aiDb.routineSuggestion === 'PENDING' ? suggestionToRoutine(MOCK_ROUTINE_SUGGESTION, MOCK_WAKE_MINUTE) : null;
  }
  if (id === 'new') return suggestedRoutine(sourceJournal ?? null);
  const r = aiDb.routines.find((x) => x.id === id);
  return r ? copy(r) : null;
}

// 루틴 저장 — 초안이면 새로 만들고 제안한 일기를 수락으로 바꿈 (routines + 단계 알람, 실데이터는 저장 뒤 폰이 예약)
export async function saveRoutine(routine: Routine): Promise<Routine> {
  if (!isMock()) return real.saveRoutine(routine);
  const saved = copy({
    ...routine,
    id: routine.id ?? `r${aiDb.routines.length + 2}`, // r1은 아침 루틴
    steps: routine.steps.map((s) => ({ ...s, name: s.name.trim() || '새 단계' })),
  });
  // 고친 루틴도 목록 맨 뒤로 — "가장 최근 저장"이 마지막 (실데이터는 routines.updated_at 순)
  const i = aiDb.routines.findIndex((x) => x.id === saved.id);
  if (i >= 0) aiDb.routines.splice(i, 1);
  aiDb.routines.push(saved);
  const j = saved.sourceJournal ? aiDb.journals[saved.sourceJournal] : undefined;
  if (j) j.suggestion = 'APPLIED';
  if (routine.id == null && saved.sourceSuggestion === MOCK_ROUTINE_SUGGESTION.id) aiDb.routineSuggestion = 'ACCEPTED';
  db.events.push({ at: now(), label: `루틴 저장 · ${saved.title}`, source: '직접 입력' });
  return copy(saved);
}

function copy(r: Routine): Routine {
  return { ...r, days: [...r.days], steps: r.steps.map((s) => ({ ...s })) };
}
