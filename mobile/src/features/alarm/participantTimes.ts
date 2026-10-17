// 출발 · 도착 시각을 appointment_participants에 쓰는 한 곳 (7장 A · B · D, #40 · #41 · #36 지오펜스)
//   부르는 곳은 둘: 지금은 원탭 뒤처리(oneTap.ts, source BUTTON), 지오펜스(위치)가 붙으면 같은 함수를 source LOCATION으로 부름.
//   · 출처 우선순위 — 사용자 응답(원탭 BUTTON · 직접 입력 MANUAL) > 위치(LOCATION). 위치 값이 먼저 있어도 응답이 덮고, 응답 값이 있으면 위치는 못 덮음. 같은 출처끼리는 먼저 쓴 값을 유지
//     appointment_participants에는 출처 칸이 없어서 alarm_events.input_source로 판단함: 지금 들어 있는 값의 시각과 같은 시각의 응답 기록(출발 알람의 ACKNOWLEDGED · 도착 알람의 ARRIVAL_CONFIRMED,
//     input_source BUTTON · MANUAL)이 있으면 응답으로 쓴 값. → 부르는 쪽은 값을 쓰기 전에 같은 시각의 기록을 alarm_events에 남겨야 함 (원탭은 폰이 남기고 올린 뒤에 이 함수를 부름)
//   · 지각 — 약속 + 5분을 넘으면 지각, 응답으로 받은 도착은 그대로 판정. 위치로 잡은 도착은 −2 ~ +5분이 경계 구간이라 판정을 보류(is_late NULL)하고 도착 확인 원탭을 기다림 (D)
//   · 준비 실측 — 출발 시각이 들어오면 daily_records.actual_prepare_minutes = 출발 − max(실제 기상 wake_confirmed_at, 예정 기상 = 그날 기상 알람 시각) (#41, B). 출처와 상관없이
//     하루에 한 번만(이미 값이 있으면 덮지 않음 — 같은 날 약속이 여러 개여도 먼저 들어온 출발이 준비 실측). 단 같은 참여 조건의 출발이 응답으로 바뀌어 그 출발로 셈한 값이면 새 출발로 다시 셈
//   · 같은 입력으로 다시 불려도 같은 결과 (onEventsUploaded 훅이 던지면 기록이 다시 넘어오므로)
// 판정은 순수 함수(시험: __tests__/participantTimes.test.ts), 아래 recordParticipantTimes가 DB를 읽고 씀
import { dbTimeMs } from '@/lib/dbTime';
import { addDays, dayKey, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import type { Enums } from '@/types/database';

// 출발 · 도착이 어디서 왔는지 — alarm_events.input_source의 일부
export type TimeSource = Extract<Enums<'event_input_source'>, 'BUTTON' | 'MANUAL' | 'LOCATION'>;

// 사용자가 직접 알려 준 것 (원탭 · 직접 입력)
export const isResponse = (source: TimeSource): boolean => source !== 'LOCATION';

// 약속 시각보다 이만큼(분)을 넘어서 도착하면 지각 — D · #41 ("+5분 넘으면 지각")
export const LATE_AFTER_MINUTES = 5;
// 위치로 잡은 도착이 약속보다 이만큼(분) 이상 일찍이면 제시간. 그 사이(−2 ~ +5분)는 경계 구간이라 보류 — D
export const ON_TIME_BEFORE_MINUTES = 2;

// isLate / lateMinutes가 null이면 판정 보류 (appointment_participants.is_late · late_minutes는 NULL 허용 — 도착 확인이 없으면 NULL, 4.7)
export type ArrivalJudgment = { isLate: boolean | null; lateMinutes: number | null };

export function judgeArrival(arrivedAtMs: number, appointmentAtMs: number, source: TimeSource = 'BUTTON'): ArrivalJudgment {
  const diffMinutes = (arrivedAtMs - appointmentAtMs) / 60_000;
  if (diffMinutes > LATE_AFTER_MINUTES) return { isLate: true, lateMinutes: Math.round(diffMinutes) };
  // 응답으로 받은 도착은 사용자 말 그대로, 위치로 잡았어도 −2분보다 일찍이면 제시간
  if (isResponse(source) || diffMinutes < -ON_TIME_BEFORE_MINUTES) return { isLate: false, lateMinutes: 0 };
  return { isLate: null, lateMinutes: null };
}

// 이미 들어 있는 값 앞에서 새 값을 어떻게 할지 — new = 빈 칸에 씀, override = 위치로 쓴 값을 응답으로 덮음, keep = 그대로
export type WriteDecision = 'new' | 'override' | 'keep';

export function decideWrite(incoming: TimeSource, existing: { present: boolean; byResponse: boolean }): WriteDecision {
  if (!existing.present) return 'new';
  return isResponse(incoming) && !existing.byResponse ? 'override' : 'keep';
}

// 준비 실측(분) = 출발 − max(실제 기상, 예정 기상). 기상 기록이 둘 다 없거나 출발이 기상보다 빠르면 null (비움)
export function prepareMinutesOf(departedAtMs: number, confirmedWakeMs: number | null, scheduledWakeMs: number | null): number | null {
  const bases = [confirmedWakeMs, scheduledWakeMs].filter((x): x is number => x != null && Number.isFinite(x));
  if (!bases.length) return null;
  const minutes = Math.round((departedAtMs - Math.max(...bases)) / 60_000);
  return minutes > 0 ? minutes : null;
}

// 이미 준비 실측이 있으면 덮지 않음. 예외: 지금 값이 이 참여 조건의 이전 출발로 셈한 값이면 (출발이 바뀐 것이니) 새 출발로 다시 씀
export function mayWritePrepare(existing: number | null, computedFromPreviousDeparture: number | null): boolean {
  return existing == null || (computedFromPreviousDeparture != null && existing === computedFromPreviousDeparture);
}

export type RecordTimesInput = {
  participantId: string;
  departedAt?: Date | number; // 출발 시각
  arrivedAt?: Date | number; // 도착 시각
  source: TimeSource;
};

export type RecordTimesResult = {
  departed: WriteDecision | null; // 받은 출발이 없거나 참여 조건이 없으면 null
  arrived: WriteDecision | null;
  prepareMinutes: number | null; // 이번에 daily_records에 쓴 준비 실측 (안 썼으면 null)
};

const toMs = (value: Date | number | undefined): number | null => (value == null ? null : typeof value === 'number' ? value : value.getTime());

// 이 참여 조건의 출발 · 도착을 응답으로 알린 기록의 시각 (ms) — 지금 들어 있는 값이 응답으로 쓴 것인지 알아보는 데 씀
async function loadResponseTimes(userId: string, participantId: string): Promise<{ departed: number[]; arrived: number[] }> {
  const { data, error } = await supabase
    .from('alarm_events')
    .select('event_type, event_at, alarms!inner(alarm_type, participant_id)')
    .eq('user_id', userId)
    .eq('alarms.participant_id', participantId)
    .in('event_type', ['ACKNOWLEDGED', 'ARRIVAL_CONFIRMED'])
    .in('input_source', ['BUTTON', 'MANUAL']);
  if (error) throw error;
  const rows = data ?? [];
  const timesOf = (eventType: string, alarmType: string) =>
    rows.filter((r) => r.event_type === eventType && r.alarms?.alarm_type === alarmType).map((r) => dbTimeMs(r.event_at));
  return { departed: timesOf('ACKNOWLEDGED', 'DEPARTURE'), arrived: timesOf('ARRIVAL_CONFIRMED', 'ARRIVE') };
}

// 준비 실측을 그날 daily_records에 씀. 쓴 값(분)을 돌려주고, 안 썼으면 null
async function recordPrepareMinutes(userId: string, departedAtMs: number, previousDepartedAtMs: number | null): Promise<number | null> {
  const departed = new Date(departedAtMs);
  const day = startOfDay(departed);
  const [record, wake] = await Promise.all([
    supabase.from('daily_records').select('record_id, wake_confirmed_at, actual_prepare_minutes').eq('user_id', userId).eq('record_date', dayKey(departed)).maybeSingle(),
    // 예정 기상 = 그날 켜 둔 기상 알람 중 가장 이른 것 (여러 약속이 있어도 하루의 첫 기상)
    supabase
      .from('alarms')
      .select('scheduled_at')
      .eq('user_id', userId)
      .eq('alarm_type', 'WAKE')
      .eq('is_enabled', true)
      .gte('scheduled_at', day.toISOString())
      .lt('scheduled_at', addDays(day, 1).toISOString())
      .order('scheduled_at')
      .limit(1),
  ]);
  if (record.error) throw record.error;
  if (wake.error) throw wake.error;

  const confirmedMs = record.data?.wake_confirmed_at ? dbTimeMs(record.data.wake_confirmed_at) : null;
  const scheduledMs = wake.data?.[0] ? dbTimeMs(wake.data[0].scheduled_at) : null;
  const minutes = prepareMinutesOf(departedAtMs, confirmedMs, scheduledMs);
  if (minutes == null) return null;
  const existing = record.data?.actual_prepare_minutes ?? null;
  const fromPrevious = previousDepartedAtMs == null ? null : prepareMinutesOf(previousDepartedAtMs, confirmedMs, scheduledMs);
  if (!mayWritePrepare(existing, fromPrevious) || existing === minutes) return null;

  if (!record.data) {
    const inserted = await supabase.from('daily_records').insert({ user_id: userId, record_date: dayKey(departed), actual_prepare_minutes: minutes, data_source: 'ALARM' });
    if (!inserted.error) return minutes;
    if (inserted.error.code !== '23505') throw inserted.error; // 그 사이 다른 곳이 그날 행을 만들었으면 아래처럼 빈 칸만 채움
    const refreshed = await supabase.from('daily_records').select('actual_prepare_minutes').eq('user_id', userId).eq('record_date', dayKey(departed)).maybeSingle();
    if (refreshed.error) throw refreshed.error;
    if (refreshed.data?.actual_prepare_minutes != null) return null;
  }
  const base = supabase.from('daily_records').update({ actual_prepare_minutes: minutes }).eq('user_id', userId).eq('record_date', dayKey(departed));
  const { error } = await (existing == null ? base.is('actual_prepare_minutes', null) : base.eq('actual_prepare_minutes', existing));
  if (error) throw error;
  return minutes;
}

// 출발 · 도착 시각 기록. 일시 오류(네트워크 등)는 던짐 — 부르는 쪽이 다시 부를 수 있게 (같은 입력이면 같은 결과)
export async function recordParticipantTimes(input: RecordTimesInput): Promise<RecordTimesResult> {
  const result: RecordTimesResult = { departed: null, arrived: null, prepareMinutes: null };
  const departedMs = toMs(input.departedAt);
  const arrivedMs = toMs(input.arrivedAt);
  if (departedMs == null && arrivedMs == null) return result;
  const userId = await requireUserId();

  const found = await supabase
    .from('appointment_participants')
    .select('participant_id, departed_at, arrived_at, appointments(appointment_at)')
    .eq('participant_id', input.participantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (found.error) throw found.error;
  const row = found.data;
  if (!row) return result; // 지워진 참여 조건

  // 응답이 들어올 때만 지금 값의 출처를 알아봄 (위치는 값이 있으면 어차피 못 덮음)
  const responses =
    isResponse(input.source) && ((departedMs != null && row.departed_at != null) || (arrivedMs != null && row.arrived_at != null))
      ? await loadResponseTimes(userId, input.participantId)
      : { departed: [] as number[], arrived: [] as number[] };
  const byResponse = (stored: string | null, times: readonly number[]) => stored != null && times.includes(dbTimeMs(stored));

  let finalDepartedMs: number | null = null;
  let replacedDepartedMs: number | null = null;
  if (departedMs != null) {
    const decision = decideWrite(input.source, { present: row.departed_at != null, byResponse: byResponse(row.departed_at, responses.departed) });
    result.departed = decision;
    if (decision === 'keep') {
      finalDepartedMs = dbTimeMs(row.departed_at as string);
    } else {
      const update = supabase.from('appointment_participants').update({ departed_at: new Date(departedMs).toISOString() }).eq('participant_id', input.participantId).eq('user_id', userId);
      // 읽은 뒤 그 사이 다른 곳이 쓴 값을 덮지 않게 읽은 값 그대로일 때만
      const { error } = await (decision === 'new' ? update.is('departed_at', null) : update.eq('departed_at', row.departed_at as string));
      if (error) throw error;
      finalDepartedMs = departedMs;
      if (decision === 'override') replacedDepartedMs = dbTimeMs(row.departed_at as string);
    }
  }

  if (arrivedMs != null) {
    const decision = decideWrite(input.source, { present: row.arrived_at != null, byResponse: byResponse(row.arrived_at, responses.arrived) });
    result.arrived = decision;
    const appointmentAt = row.appointments?.appointment_at;
    if (decision !== 'keep') {
      // 약속 시각을 못 읽으면 지각은 보류 (도착 시각만 남김)
      const { isLate, lateMinutes } = appointmentAt ? judgeArrival(arrivedMs, dbTimeMs(appointmentAt), input.source) : { isLate: null, lateMinutes: null };
      const update = supabase
        .from('appointment_participants')
        .update({ arrived_at: new Date(arrivedMs).toISOString(), is_late: isLate, late_minutes: lateMinutes })
        .eq('participant_id', input.participantId)
        .eq('user_id', userId);
      const { error } = await (decision === 'new' ? update.is('arrived_at', null) : update.eq('arrived_at', row.arrived_at as string));
      if (error) throw error;
    }
  }

  if (finalDepartedMs != null) result.prepareMinutes = await recordPrepareMinutes(userId, finalDepartedMs, replacedDepartedMs);
  return result;
}
