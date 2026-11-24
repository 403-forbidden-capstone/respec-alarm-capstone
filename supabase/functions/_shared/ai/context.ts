// 문맥 모으기 (DB 읽기) — voice-session이 대화 시작 때 한 번 읽는다 (설계 메모 4 · 4.5절). 읽은 행을 해석하는 일은 context-core.ts(순수)가 한다.
// 읽기는 모두 부른 사람의 RLS 클라이언트(userDb)로 — 남의 일정 · 기록에는 닿지 못한다. 쿼리 모양은 앞 출발만 앱(#240 mobile/src/features/location/real.ts listEarlierDepartures)과 같게 맞춤.
//   쿼리: ① 프로필(시간대 · 별명) ② 돌아볼 날 기상 기록(daily_records) ③ 돌아볼 날 ~ 내일 + LATER_DAYS일 내 참여 약속(그룹 이름 포함) ④ 그날 기상 확인 기록(출처) ⑤ 앞 출발(alarm_events) ⑥ 안 끝낸 할 일 · 준비물
//         ⑦ 내일 ~ LATER_DAYS일 내 알람(참여 행 알람 + 일정 없는 기상) — 내일 뒤는 고칠 대상 찾기용(context-core later)
// 시각은 서울 +09:00 고정(view.ts와 같음, 설계 메모 11절 "v0 Asia/Seoul만") — 다른 시간대면 서울로 보고 tzSupported false로 알린다.
import { must } from '../db.ts';

// supabase-js가 select 문자열에서 추론한 모양(임베드를 배열로 봄)이 실제 PostgREST의 다대일 임베드(객체)와 달라서, 읽은 행의 모양은 이 파일의 행 타입으로 단정한다
const read = <T>(context: string, res: unknown): T => must<T>(context, res as { data: T | null; error: { message: string; code?: string } | null });
import type { Db } from '../supabase.ts';
import { safeTimeZone } from '../tz.ts';
import type { AlarmRow, ContextInput, EarlierRow, InputSource, ParticipantJoin, TodoRow, WakeRecord } from './context-core.ts';
import { LATER_DAYS, seoulParts } from './context-core.ts';
import { dayOf, dayStartIso, type ConversationDays } from './turn-core.ts';
import { addDays } from './view.ts';

export interface ContextDeps {
  userId: string;
  userDb: Db;
}

/** 서울 ISO 시각 ("2026-10-29T20:30:00+09:00") */
export function seoulIso(d: Date): string {
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return `${t.toISOString().slice(0, 19)}+09:00`;
}

/** 서울 날짜 0시 ("2026-10-29" → "2026-10-29T00:00:00+09:00") */
export const startOf = (date: string): string => `${date}T00:00:00+09:00`;

export interface ContextRows {
  nowIso: string;
  days: ConversationDays;
  /** buildContext 입력 (question · confirmFactIds는 부르는 쪽이 채움) */
  input: Omit<ContextInput, 'question' | 'confirmFactIds'>;
  /** 대화 기준일(생활 날짜)의 새벽 4시 — 대화방 이어 받기 · 하루 상한 셈의 시작 */
  dayStart: string;
}

const PARTICIPANT_COLUMNS =
  'participant_id, appointment_id, user_id, transport_type, est_travel_minutes, departed_at, departed_source, arrived_at, arrived_source, is_late, late_minutes, appointments!inner(appointment_id, title, appointment_at, dest_name, importance, recurrence_rule, group_id, groups(group_name))';

type ParticipantRaw = Omit<ParticipantJoin, 'appointment'> & { appointments: ParticipantJoin['appointment'] };

export async function readContextRows(deps: ContextDeps, now: Date): Promise<ContextRows> {
  const { userId, userDb } = deps;
  const nowIso = seoulIso(now);
  // 대화 기준일 — 새벽 4시 경계 (시간대는 경고 플래그에만 씀, 계산은 서울)
  const { review, morning } = dayOf(nowIso, 'Asia/Seoul');

  // ① 프로필 · ② 돌아볼 날 기상 기록
  const [profile, records] = await Promise.all([
    userDb.from('profiles').select('timezone, nickname').eq('user_id', userId).maybeSingle(),
    userDb.from('daily_records').select('record_date, wake_confirmed_at').eq('user_id', userId).eq('record_date', review),
  ]);
  const prof = read<{ timezone: string | null; nickname: string | null } | null>('profiles', profile);
  const recs = read<{ record_date: string; wake_confirmed_at: string | null }[]>('daily_records', records) ?? [];
  const days = dayOf(nowIso, safeTimeZone(prof?.timezone));
  const reviewStart = startOf(review);
  const reviewEnd = startOf(addDays(review, 1));
  const windowEnd = startOf(addDays(morning, 1 + LATER_DAYS));

  // ③ 참여 약속(돌아볼 날 ~ 내일) · ④ 기상 확인 출처 · ⑤ 앞 출발 · ⑥ 할 일
  const [parts, wakeEvents, earlier, todoRes] = await Promise.all([
    userDb
      .from('appointment_participants')
      .select(PARTICIPANT_COLUMNS)
      .eq('user_id', userId)
      .gte('appointments.appointment_at', reviewStart)
      .lt('appointments.appointment_at', windowEnd),
    userDb
      .from('alarm_events')
      .select('event_at, input_source')
      .eq('user_id', userId)
      .eq('event_type', 'WAKE_CONFIRMED')
      .gte('event_at', reviewStart)
      .lt('event_at', reviewEnd)
      .order('event_at', { ascending: true }),
    userDb
      .from('alarm_events')
      .select('event_at, alarms(alarm_type, participant_id, appointment_participants(departed_at, departed_source))')
      .eq('user_id', userId)
      .eq('event_type', 'ACKNOWLEDGED')
      .eq('input_source', 'LOCATION')
      .gte('event_at', reviewStart)
      .lt('event_at', reviewEnd),
    userDb.from('todos').select('todo_id, appointment_id, title, todo_type, due_date, is_done').eq('user_id', userId).eq('is_done', false),
  ]);
  const participants = (read<ParticipantRaw[]>('appointment_participants', parts) ?? []).map((p): ParticipantJoin => {
    const { appointments, ...rest } = p;
    return { ...rest, appointment: appointments };
  });

  // ⑦ 내일 ~ 이후 알람 — 내일 · 이후 참여 행의 알람 + 일정 없는 기상(지금 뒤 ~ 창 끝)
  const morningIds = participants.filter((p) => seoulParts(p.appointment.appointment_at).date >= morning).map((p) => p.participant_id);
  const [partAlarms, soloAlarms] = await Promise.all([
    morningIds.length === 0
      ? Promise.resolve({ data: [] as AlarmRow[], error: null })
      : userDb.from('alarms').select('alarm_id, participant_id, routine_id, alarm_type, scheduled_at, intensity, is_enabled, time_source').eq('user_id', userId).in('participant_id', morningIds),
    userDb
      .from('alarms')
      .select('alarm_id, participant_id, routine_id, alarm_type, scheduled_at, intensity, is_enabled, time_source')
      .eq('user_id', userId)
      .is('participant_id', null)
      .is('routine_id', null)
      .eq('alarm_type', 'WAKE')
      .gt('scheduled_at', nowIso)
      .lt('scheduled_at', windowEnd),
  ]);
  const alarms = [...(read<AlarmRow[]>('alarms', partAlarms) ?? []), ...(read<AlarmRow[]>('alarms', soloAlarms) ?? [])];

  // 기상 기록: 시각은 daily_records, 출처는 그날 첫 WAKE_CONFIRMED 기록(없으면 직접 입력으로 봄 — context-core)
  const reviewRecord = recs.find((r) => r.record_date === review);
  const firstWake = (read<{ event_at: string; input_source: InputSource | null }[]>('alarm_events', wakeEvents) ?? [])[0];
  const confirmedAt = reviewRecord?.wake_confirmed_at ?? firstWake?.event_at ?? null;
  const wake: WakeRecord | null = confirmedAt === null ? null : { confirmed_at: confirmedAt, input_source: firstWake?.input_source ?? null };

  return {
    nowIso,
    days,
    dayStart: dayStartIso(review),
    input: {
      type: 'BEFORE_SLEEP',
      now: nowIso,
      days: { review, morning },
      nickname: prof?.nickname ?? null,
      participants,
      alarms,
      wake,
      earlierRows: read<EarlierRow[]>('alarm_events', earlier) ?? [],
      earlierRange: { from: reviewStart, to: reviewEnd },
      todos: read<TodoRow[]>('todos', todoRes) ?? [],
    },
  };
}
