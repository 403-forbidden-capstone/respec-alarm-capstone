// alarm-briefing의 기상 알람 데이터 읽기 — 그날 내 일정 · 할 일 · 준비물 · 전날 대화(structured.v1) · 같은 약속 출발 시각
//   index.ts에서 옮김 (가짜 DB로 시험하려고, 시험: briefing-load.test.ts). 사용자 DB(RLS) + user_id로 본인 것만
//   일정은 어디서 만들었든(홈탭 직접 입력 · AI 대화 카드 저장 · 시간표) 같은 표(appointments · appointment_participants)라 똑같이 읽힘
//   전날 대화가 없어도 일정 · 준비물은 그대로 — sessions만 빈 배열
import type { BriefAppointment, BriefTodo, Importance, StructuredLike } from './briefing.ts';
import { briefingDays } from './briefing-run.ts';
import { must } from './db.ts';
import type { Db } from './supabase.ts';
import { localDayRange } from './tz.ts';

type DayRow = { appointment_id: string; appointments: { title: string; appointment_at: string; importance: Importance; exception_kind: string | null } };
type TodoRow = { todo_id: string; title: string; todo_type: 'TASK' | 'ITEM'; appointment_id: string | null };

export type WakeData = { appointments: BriefAppointment[]; todos: BriefTodo[]; sessions: StructuredLike[]; departAtMs: number | null };

/**
 * 기상 알람 하나의 브리핑 재료
 *   일정: 그날(사용자 시간대) 내가 참여한 일정 중 이번만 지운(CANCELED) 회차를 뺀 것. 알람 시각 이후만 고르는 것은 runBriefing이 함
 *   할 일 · 준비물(안 끝낸 것만, 개수 제한 없음):
 *     안내할 일정(알람 시각 이후 · 안 지운 것)에 붙은 것 + 일정에 안 붙은 그날 마감인 것
 *     지난 일정 · 지운 회차에 붙은 것은 빼고(그날 날짜가 붙어 있어도), 다른 날 것도 뺌
 */
export async function loadWakeData(db: Db, userId: string, a: { scheduledAtMs: number; timeZone: string; participantId: string | null }): Promise<WakeData> {
  const { day, review } = briefingDays(a.scheduledAtMs, a.timeZone);
  const { start, end } = localDayRange(new Date(a.scheduledAtMs), a.timeZone);

  let departAtMs: number | null = null;
  if (a.participantId) {
    const dep = must<{ scheduled_at: string }[]>(
      'departure',
      await db.from('alarms').select('scheduled_at').eq('user_id', userId).eq('participant_id', a.participantId).eq('alarm_type', 'DEPARTURE').eq('is_enabled', true).limit(1),
    );
    departAtMs = dep[0] ? Date.parse(dep[0].scheduled_at) : null;
  }

  const dayRows = must<DayRow[]>(
    'day appointments',
    await db
      .from('appointment_participants')
      .select('appointment_id, appointments!inner(title, appointment_at, importance, exception_kind)')
      .eq('user_id', userId)
      .gte('appointments.appointment_at', start.toISOString())
      .lt('appointments.appointment_at', end.toISOString()),
  ).filter((r) => r.appointments.exception_kind !== 'CANCELED');
  const appointments = dayRows.map((r): BriefAppointment => ({ title: r.appointments.title, atMs: Date.parse(r.appointments.appointment_at), importance: r.appointments.importance }));
  const ahead = dayRows.filter((r) => Date.parse(r.appointments.appointment_at) >= a.scheduledAtMs).map((r) => r.appointment_id);

  // 두 번 읽어 합침 (안내할 일정에 붙은 것 · 그날 마감인 것) — 예전 limit(20)을 없애 준비물이 잘리지 않게
  const cols = 'todo_id, title, todo_type, appointment_id';
  const linked = ahead.length
    ? must<TodoRow[]>('todos', await db.from('todos').select(cols).eq('user_id', userId).eq('is_done', false).in('appointment_id', ahead).order('created_at'))
    : [];
  const dueToday = must<TodoRow[]>('todos', await db.from('todos').select(cols).eq('user_id', userId).eq('is_done', false).eq('due_date', day).is('appointment_id', null).order('created_at'));
  const seen = new Set<string>();
  const todos = [...linked, ...dueToday].filter((t) => !seen.has(t.todo_id) && seen.add(t.todo_id)).map((t): BriefTodo => ({ title: t.title, type: t.todo_type }));

  const sessions = must<{ extracted_data: StructuredLike | null }[]>(
    'sessions',
    await db.from('conversation_sessions').select('extracted_data').eq('user_id', userId).eq('extracted_data->session->>reference_date', review),
  ).flatMap((s) => (s.extracted_data ? [s.extracted_data] : []));

  return { appointments, todos, sessions, departAtMs };
}
