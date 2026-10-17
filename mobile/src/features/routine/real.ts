// ⑥ AI 일기 · 루틴 · 준비물 — 실데이터(Supabase) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6)
//   · 쿼리는 이 파일에서 얇게, 행 ↔ 화면 타입 변환은 map.ts (루틴 저장 모양은 D29가 열려 있어 map.ts 맨 위에 정리)
//   · 읽기 실패는 DB 원문 그대로 던지고(화면이 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
//   · 읽고 쓰는 곳은 docs/screen-data-map.md H01 · A03 · A04. 루틴 단계 알람을 바꾸면 그 알람만 reconcile (실데이터 연결 규칙)
//   · 일기 만들기는 AI(Edge)라 여기 없음 — 일기가 없으면 화면이 "일기 없음"을 보여 줌
import { EVENING_START_MINUTE, parseDayParam } from '@/features/alarm/schedule';
import { loadActualRows } from '@/features/records/real';
import { reconcile } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { addDays, dayKey, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import {
  blankRoutine,
  isUuid,
  journalFacts,
  nextAckStep,
  pickTodayRoutine,
  planRoutineAlarms,
  routineFields,
  routineProgress,
  toEveningRoutine,
  toJournal,
  toRoutine,
  toTodo,
  weekdayOf,
  type RoutineRow,
} from './map';
import type { EveningRoutine, Journal, Routine, RoutineProgress, Todo } from './types';

const ROUTINE_SELECT = 'routine_id, title, goal, repeat_days, steps, is_active, daily_journals(record_date)';

async function loadRoutine(userId: string, id: string): Promise<Routine | null> {
  if (!isUuid(id)) return null; // 가짜 데이터 주소(r1)가 남아 있어도 DB 오류 대신 "없음"
  const { data, error } = await supabase.from('routines').select(ROUTINE_SELECT).eq('user_id', userId).eq('routine_id', id).maybeSingle();
  if (error) throw error;
  return data ? toRoutine(data) : null;
}

// ---------------------------------------------------------------------------
// H01 오늘 루틴
// ---------------------------------------------------------------------------

// 루틴의 단계 알람과, 오늘 그 알람에 쌓인 확인(ACKNOWLEDGED) — 알람 id · 확인한 단계 번호
async function loadStepState(userId: string, routineId: string, day: Date) {
  const alarms = await supabase.from('alarms').select('alarm_id, step_order').eq('user_id', userId).eq('routine_id', routineId);
  if (alarms.error) throw alarms.error;
  const ids = (alarms.data ?? []).map((a) => a.alarm_id);
  if (!ids.length) return { alarmIds: [] as string[], acked: [] as number[], byOrder: new Map<number, string>() };
  const from = startOfDay(day);
  const events = await supabase
    .from('alarm_events')
    .select('alarm_id')
    .eq('user_id', userId)
    .eq('event_type', 'ACKNOWLEDGED')
    .in('alarm_id', ids)
    .gte('event_at', from.toISOString())
    .lt('event_at', addDays(from, 1).toISOString());
  if (events.error) throw events.error;
  const orderOf = new Map((alarms.data ?? []).flatMap((a) => (a.step_order == null ? [] : ([[a.alarm_id, a.step_order]] as const))));
  return {
    alarmIds: ids,
    acked: (events.data ?? []).flatMap((e) => orderOf.get(e.alarm_id) ?? []),
    byOrder: new Map([...orderOf].map(([alarmId, order]) => [order, alarmId] as const)),
  };
}

// 오늘 루틴 (아침) — 켜져 있고 오늘 요일이 든 루틴. 끝낸 단계는 오늘 단계 알람에 쌓인 확인으로
export async function getTodayRoutine(): Promise<RoutineProgress | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('routines').select(ROUTINE_SELECT).eq('user_id', userId).eq('is_active', true);
  if (error) throw error;
  const today = startOfDay(now());
  const routine = pickTodayRoutine(
    (data ?? []).flatMap((row: RoutineRow) => toRoutine(row) ?? []),
    weekdayOf(today),
    EVENING_START_MINUTE,
  );
  if (!routine?.id) return null;
  const state = await loadStepState(userId, routine.id, today);
  return routineProgress(routine, state.acked);
}

// 다음 단계 완료 — 다음 알람 있는 단계를 오늘 확인한 것으로 기록 (폰의 "했어요" 원탭과 같은 ACKNOWLEDGED, 출처는 직접 입력). 다 끝낸 뒤 한 번 더 누르면 오늘 확인을 지우고 처음부터
//   알람이 없는 단계는 기록을 달 곳(alarm_events는 알람에 붙음)이 없어 뒤 단계를 확인하면 같이 끝난 것으로 셈. 남은 단계에 알람이 없으면 거절
export async function advanceRoutine(id: string): Promise<RoutineProgress | null> {
  const userId = await requireUserId();
  const routine = await loadRoutine(userId, id);
  if (!routine?.id) return null;
  const today = startOfDay(now());
  const state = await loadStepState(userId, routine.id, today);
  const progress = routineProgress(routine, state.acked);
  if (!progress) return null;

  if (progress.done >= routine.steps.length) {
    const { error } = await supabase
      .from('alarm_events')
      .delete()
      .eq('user_id', userId)
      .eq('event_type', 'ACKNOWLEDGED')
      .in('alarm_id', state.alarmIds)
      .gte('event_at', today.toISOString())
      .lt('event_at', addDays(today, 1).toISOString());
    if (error) throw error;
    return { ...progress, done: 0 };
  }

  const order = nextAckStep(routine, progress.done);
  const alarmId = order == null ? undefined : state.byOrder.get(order);
  if (order == null || !alarmId) throw new UserError('남은 단계에 알람이 없어서 끝낸 것으로 기록할 수 없어요');
  const { error } = await supabase.from('alarm_events').insert({ alarm_id: alarmId, user_id: userId, event_type: 'ACKNOWLEDGED', event_at: now().toISOString(), input_source: 'MANUAL' });
  if (error) throw error;
  return routineProgress(routine, [...state.acked, order]);
}

// ---------------------------------------------------------------------------
// H01 준비물 (todos ITEM)
// ---------------------------------------------------------------------------

// 그날 준비물 — due_date가 그날인 것 (일정을 저장할 때 약속 날짜로 넣음)
export async function listTodos(day: Date): Promise<Todo[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('todos')
    .select('todo_id, title, is_done')
    .eq('user_id', userId)
    .eq('todo_type', 'ITEM')
    .eq('due_date', dayKey(day))
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map(toTodo);
}

export async function toggleTodo(id: string) {
  const userId = await requireUserId();
  const found = await supabase.from('todos').select('is_done').eq('user_id', userId).eq('todo_id', id).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return; // 가짜와 같음 — 없는 항목은 그냥 넘어감
  const done = !found.data.is_done;
  const { error } = await supabase
    .from('todos')
    .update({ is_done: done, done_at: done ? now().toISOString() : null })
    .eq('user_id', userId)
    .eq('todo_id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// A03 하루 기록 · 일기 — 읽기 · 고치기 · 루틴 제안 응답만 (만들기는 AI)
// ---------------------------------------------------------------------------

const JOURNAL_SELECT = 'journal_id, record_date, ai_summary, edited_summary, is_edited, coaching_insight, encouragement, routine_suggestion, suggestion_status';

export async function getJournal(recordDate: string): Promise<Journal | null> {
  const day = parseDayParam(recordDate);
  if (!day) return null;
  const userId = await requireUserId();
  const { data, error } = await supabase.from('daily_journals').select(JOURNAL_SELECT).eq('user_id', userId).eq('record_date', recordDate).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // 오늘의 사실은 R02 일간의 "실제로 일어난 일"과 같은 줄, 같은 일기에서 여러 번 만들었으면 가장 최근 루틴
  const [actual, routine] = await Promise.all([
    loadActualRows(userId, day),
    supabase.from('routines').select('routine_id').eq('user_id', userId).eq('source_journal_id', data.journal_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (routine.error) throw routine.error;
  return toJournal(data, journalFacts(actual), routine.data?.routine_id ?? null);
}

// 일기 고치기 — AI 원본(ai_summary)은 그대로 두고 고친 글(edited_summary)만 바꿈. AI 글과 같으면 고치지 않은 것
export async function editJournal(recordDate: string, text: string) {
  if (!parseDayParam(recordDate)) throw new UserError('일기를 찾을 수 없어요');
  const userId = await requireUserId();
  const found = await supabase.from('daily_journals').select('journal_id, ai_summary').eq('user_id', userId).eq('record_date', recordDate).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) throw new UserError('일기를 찾을 수 없어요');
  const edited = text !== (found.data.ai_summary ?? '');
  const { error } = await supabase
    .from('daily_journals')
    .update({ edited_summary: edited ? text : null, is_edited: edited })
    .eq('user_id', userId)
    .eq('journal_id', found.data.journal_id);
  if (error) throw error;
}

// 루틴 제안에 "괜찮아요" (suggestion_status = REJECTED) — 기다리는 제안만. 14일 동안 숨기는 기한은 D24가 열려 있어 저장하지 않음
export async function declineRoutineSuggestion(recordDate: string) {
  if (!parseDayParam(recordDate)) return; // 일기가 없으면 응답할 제안도 없음
  const userId = await requireUserId();
  const { error } = await supabase.from('daily_journals').update({ suggestion_status: 'REJECTED' }).eq('user_id', userId).eq('record_date', recordDate).eq('suggestion_status', 'PENDING');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// H01 저녁 루틴 · A04 루틴 편집
// ---------------------------------------------------------------------------

// 가장 최근에 저장한 루틴 (routines.updated_at 순). 없으면 null
export async function getEveningRoutine(): Promise<EveningRoutine | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('routines').select(ROUTINE_SELECT).eq('user_id', userId).order('updated_at', { ascending: false }).limit(5);
  if (error) throw error;
  // 최근 순으로 훑어 steps를 읽을 수 있는 첫 루틴
  const routine = (data ?? []).flatMap((row: RoutineRow) => toRoutine(row) ?? [])[0];
  return routine ? toEveningRoutine(routine) : null;
}

// 루틴 편집 — id가 'new'면 일기의 루틴 제안으로 만든 빈 초안(저장 전), 아니면 저장한 루틴. 내 루틴이 아니거나 없으면 null
export async function getRoutine(id: string, sourceJournal?: string): Promise<Routine | null> {
  const userId = await requireUserId();
  if (id === 'new') {
    const journal = sourceJournal && parseDayParam(sourceJournal) ? sourceJournal : null; // 날짜가 아닌 주소 값은 일기 없이 연 것으로
    let suggestion: string | null = null;
    if (journal) {
      const { data, error } = await supabase.from('daily_journals').select('routine_suggestion').eq('user_id', userId).eq('record_date', journal).maybeSingle();
      if (error) throw error;
      suggestion = data?.routine_suggestion ?? null;
    }
    return blankRoutine(journal, suggestion);
  }
  return loadRoutine(userId, id);
}

// 단계 알람을 켜 둔 단계마다 alarms(ROUTINE) 한 줄 — 처음 울릴 시각만 (반복의 다음 회차는 서버 배치 몫, D4). 이미 있는 단계는 시각만 고치고, 없어진 단계는 끔
//   없어진 단계 알람(루틴을 끄거나 단계 · 알람을 뺌)은 지우지 않고 is_enabled를 끔: 알람을 지우면 그 알람의 울림 · 확인 기록(alarm_events)이 같이 사라짐 (on delete cascade).
//   단계를 다시 켜면 아래 갱신 길이 같은 줄(루틴 · 단계 번호가 하나뿐인 alarms_routine_step_key)을 다시 켜므로 번호가 겹쳐 새로 못 만드는 일은 없음
//   touched = 폰에 맞춰야 할 알람 id (이미 있던 것 · 새로 만든 것) — 중간에 실패해도 그때까지 알게 된 id를 부른 쪽이 폰에 맞출 수 있게 밖에서 받음
async function syncStepAlarms(userId: string, routineId: string, routine: Routine, from: Date, touched: Set<string>): Promise<void> {
  const existing = await supabase.from('alarms').select('alarm_id, step_order, is_enabled').eq('user_id', userId).eq('routine_id', routineId);
  if (existing.error) throw existing.error;
  const rows = existing.data ?? [];
  const wanted = routine.active ? planRoutineAlarms(routine, from) : []; // 꺼 둔 루틴은 알람을 걸지 않음
  for (const r of rows) touched.add(r.alarm_id);

  const stale = rows.filter((r) => r.is_enabled && !wanted.some((w) => w.stepOrder === r.step_order));
  if (stale.length) {
    const { error } = await supabase.from('alarms').update({ is_enabled: false }).eq('user_id', userId).in('alarm_id', stale.map((r) => r.alarm_id));
    if (error) throw error;
  }
  const created: { user_id: string; routine_id: string; step_order: number; alarm_type: 'ROUTINE'; scheduled_at: string; is_enabled: boolean }[] = [];
  for (const w of wanted) {
    const row = rows.find((r) => r.step_order === w.stepOrder);
    if (row) {
      const { error } = await supabase.from('alarms').update({ scheduled_at: w.at.toISOString(), is_enabled: true, last_calculated_at: from.toISOString() }).eq('user_id', userId).eq('alarm_id', row.alarm_id);
      if (error) throw error;
    } else {
      created.push({ user_id: userId, routine_id: routineId, step_order: w.stepOrder, alarm_type: 'ROUTINE', scheduled_at: w.at.toISOString(), is_enabled: true });
    }
  }
  if (created.length) {
    const { data, error } = await supabase.from('alarms').insert(created).select('alarm_id');
    if (error) throw error;
    for (const a of data ?? []) touched.add(a.alarm_id);
  }
}

// 루틴 저장 — routines 한 줄 + 단계 알람 + (제안에서 왔으면) 그 일기의 제안을 수락으로. 저장이 끝나면 바뀐 알람만 폰에 맞춤
//   새 루틴을 만든 뒤 알람 저장이 실패하면 방금 만든 루틴을 지움 (화면의 초안에는 id가 없어 다시 저장하면 루틴이 둘이 되므로)
export async function saveRoutine(routine: Routine): Promise<Routine> {
  const userId = await requireUserId();
  const steps = routine.steps.map((s) => ({ ...s, name: s.name.trim() || '새 단계' }));
  const draft: Routine = { ...routine, steps };

  let journalId: string | null = null;
  if (routine.sourceJournal && parseDayParam(routine.sourceJournal)) {
    const { data, error } = await supabase.from('daily_journals').select('journal_id').eq('user_id', userId).eq('record_date', routine.sourceJournal).maybeSingle();
    if (error) throw error;
    journalId = data?.journal_id ?? null;
  }

  const fields = routineFields(draft);
  let id = routine.id;
  const created = id == null;
  if (id) {
    const { data, error } = await supabase.from('routines').update(fields).eq('user_id', userId).eq('routine_id', id).select('routine_id');
    if (error) throw error;
    if (!data?.length) throw new UserError('루틴을 찾을 수 없어요');
  } else {
    const { data, error } = await supabase
      .from('routines')
      .insert({ ...fields, user_id: userId, source_journal_id: journalId, origin: journalId ? 'AI_SUGGESTED' : 'USER' })
      .select('routine_id')
      .single();
    if (error) throw error;
    id = data.routine_id;
  }

  // 폰에 맞출 알람 — 성공이든 중간에 실패하든 마지막에 맞춤 (알람 몇 개만 바뀐 채 실패하면 폰이 서버와 달라지므로). 실패는 삼킴: 저장 결과(성공 · 원래 오류)를 가리지 않고, 앱이 앞에 올 때 다시 맞춤
  const touched = new Set<string>();
  try {
    await syncStepAlarms(userId, id, draft, now(), touched);
    if (journalId) {
      const { error } = await supabase.from('daily_journals').update({ suggestion_status: 'APPLIED' }).eq('user_id', userId).eq('journal_id', journalId);
      if (error) throw error;
    }
  } catch (e) {
    if (created) await supabase.from('routines').delete().eq('user_id', userId).eq('routine_id', id); // 알람도 같이 지워짐 (ON DELETE CASCADE)
    throw e;
  } finally {
    if (touched.size) {
      try {
        await reconcile({ alarmIds: [...touched] });
      } catch (e) {
        if (__DEV__) console.warn('[routine] 폰 예약 맞추기 실패', e);
      }
    }
  }
  return { ...draft, id };
}
