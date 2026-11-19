// 루틴 제안 만들기 (안건 D114) — suggestion-generate가 알람 조정 제안 다음에 부름 (매일 18:00 KST)
//   재료: DB 함수 routine_suggestion_inputs(p_now) — 사람마다 최근 21일 아침 기록. 규칙: calc/routine.ts suggestRoutine (#557)
//   결과: routine_suggestions에 PENDING 한 줄 (원인 · 이름 · 근거 · 초안) — 표는 #562
//   건너뜀 (사람마다):
//     · 기다리는 제안이 있으면 그 사람은 아무것도 안 만듦 (한 사람에 하나, 표의 유일 색인도 막음)
//     · 받아들여 만든 루틴이 켜져 있는 원인 (루틴이 꺼졌거나 지워졌으면 다시 후보)
//     · 넘긴 원인은 넘긴 뒤 기록이 있는 아침이 3번 쌓일 때까지 (D24 C)
//   알람 조정 제안과 원인이 겹치지 않게 하는 건 규칙 쪽(판정 순서 · "준비가 길다"는 다루지 않음)
import { suggestRoutine, type MorningFacts, type RoutineCause } from './calc/routine.ts';
import { dbFail, must } from './db.ts';
import type { Db } from './supabase.ts';

export const ROUTINE_IGNORE_WAIT = 3; // D24 C — 넘긴 뒤 기록이 있는 아침 몇 번

export type RoutineInputRow = {
  user_id: string;
  record_date: string;
  weekday: number;
  wake_alarm_at: string | null;
  wake_confirmed_at: string | null;
  wake_missed: boolean;
  prepare_alarm_at: string | null;
  prepare_started_at: string | null;
  items_due: number;
  items_late: number;
};

export type ExistingRoutineSuggestion = {
  user_id: string;
  cause: RoutineCause;
  status: 'PENDING' | 'ACCEPTED' | 'IGNORED';
  responded_at: string | null;
  routine_active: boolean; // 받아들여 만든 루틴이 아직 있고 켜져 있음
};

export type RoutineSuggestionInsert = {
  user_id: string;
  cause: RoutineCause;
  title: string;
  reason: string;
  evidence: { dates: string[]; average: number | null; missed: number };
  draft: { goal: string; days: number[]; steps: { name: string; minutes: number; alarm: boolean; offsetFromWake: number | null; at: string | null }[] };
};

const ms = (v: string | null) => (v == null ? null : Date.parse(v));

export function toMorning(r: RoutineInputRow): MorningFacts {
  return {
    date: r.record_date,
    weekday: r.weekday,
    wakeAlarmAt: ms(r.wake_alarm_at),
    wakeConfirmedAt: ms(r.wake_confirmed_at),
    wakeMissed: !!r.wake_missed,
    prepareAlarmAt: ms(r.prepare_alarm_at),
    prepareStartedAt: ms(r.prepare_started_at),
    itemsDue: r.items_due ?? 0,
    itemsLate: r.items_late ?? 0,
  };
}

// 그 사람에게 이번에 건너뛸 것 — null이면 아무것도 안 만듦(기다리는 제안이 있음)
export function skipFor(existing: readonly ExistingRoutineSuggestion[], mornings: readonly MorningFacts[]): RoutineCause[] | null {
  if (existing.some((s) => s.status === 'PENDING')) return null;
  const skip = new Set<RoutineCause>();
  for (const s of existing) {
    if (s.status === 'ACCEPTED' && s.routine_active) skip.add(s.cause);
    if (s.status === 'IGNORED' && s.responded_at) {
      const after = mornings.filter((m) => m.wakeAlarmAt != null && m.wakeAlarmAt > Date.parse(s.responded_at!)).length;
      if (after < ROUTINE_IGNORE_WAIT) skip.add(s.cause);
    }
  }
  return [...skip];
}

// 재료 → 넣을 제안 (순수)
export function planRoutineSuggestions(rows: readonly RoutineInputRow[], existing: readonly ExistingRoutineSuggestion[]): RoutineSuggestionInsert[] {
  const byUser = new Map<string, MorningFacts[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(toMorning(r));
    byUser.set(r.user_id, list);
  }
  const out: RoutineSuggestionInsert[] = [];
  for (const [userId, mornings] of byUser) {
    mornings.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const skip = skipFor(existing.filter((s) => s.user_id === userId), mornings);
    if (!skip) continue;
    const d = suggestRoutine(mornings, { skip });
    if (!d) continue;
    out.push({
      user_id: userId,
      cause: d.cause,
      title: d.title,
      reason: d.reason,
      evidence: d.evidence,
      draft: { goal: d.goal, days: d.days, steps: d.steps },
    });
  }
  return out;
}

export type RoutineSuggestResult = { users: number; created: number; skipped: number };

export async function runRoutineSuggest(db: Db, now: Date): Promise<RoutineSuggestResult> {
  const rows = (must('routine_suggestion_inputs', await db.rpc('routine_suggestion_inputs', { p_now: now.toISOString() })) as RoutineInputRow[] | null) ?? [];
  const users = [...new Set(rows.map((r) => r.user_id))];
  if (!users.length) return { users: 0, created: 0, skipped: 0 };
  const prior = must<{ user_id: string; cause: RoutineCause; status: ExistingRoutineSuggestion['status']; responded_at: string | null; routine_id: string | null }[]>(
    'routine_suggestions',
    await db.from('routine_suggestions').select('user_id, cause, status, responded_at, routine_id').in('user_id', users),
  );
  const routineIds = [...new Set(prior.map((p) => p.routine_id).filter((x): x is string => !!x))];
  const active = new Set(
    routineIds.length
      ? must<{ routine_id: string; is_active: boolean }[]>('routines', await db.from('routines').select('routine_id, is_active').in('routine_id', routineIds))
          .filter((r) => r.is_active)
          .map((r) => r.routine_id)
      : [],
  );
  const existing: ExistingRoutineSuggestion[] = prior.map((p) => ({
    user_id: p.user_id,
    cause: p.cause,
    status: p.status,
    responded_at: p.responded_at,
    routine_active: !!p.routine_id && active.has(p.routine_id),
  }));
  let created = 0;
  let skipped = 0;
  for (const plan of planRoutineSuggestions(rows, existing)) {
    const { error } = await db.from('routine_suggestions').insert(plan);
    if (!error) created += 1;
    else if (error.code === '23505') skipped += 1; // 그사이 기다리는 제안이 생김
    else dbFail('routine_suggestions insert', error);
  }
  return { users: users.length, created, skipped };
}
