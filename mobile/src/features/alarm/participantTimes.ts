// 출발 · 도착 시각을 appointment_participants에 쓰는 한 곳 (7장 A · B · D, #40 · #41 · #36 지오펜스)
//   부르는 곳: 원탭 뒤처리(oneTap.ts, source BUTTON), 지오펜스(위치, source LOCATION), 위치 값 지우기 · 되돌리기(features/location/real.ts)
//   · 출처 우선순위 — 사용자 응답(원탭 BUTTON · 직접 입력 MANUAL) > 위치(LOCATION). 위치 값이 먼저 있어도 응답이 덮고, 응답 값이 있으면 위치는 못 덮음. 같은 출처끼리는 먼저 쓴 값을 유지
//     지금 값의 출처는 출처 칸(departed_source · arrived_source)으로 읽음 — 시각만 있고 출처가 비면 옛 앱이 쓴 원탭 값이라 BUTTON (20261029060000_location_detect.sql)
//     시각을 쓸 때 출처도 같이 쓰고, 지울 때 같이 지움. 위치 값을 응답이 덮으면 출처도 응답 것으로 바뀜
//   · 지각 — 응답으로 받은 도착은 약속 + 5분을 넘으면 지각(D58). 위치로 잡은 도착은 −2 ~ +11분이 보류 구간(is_late NULL, 도착 확인 원탭을 기다림),
//     +11분 넘으면 지각 — 감지 지연만큼 넓힘 (D61, L6 안건후보: 위치 도착 지각 경계 폭 기본안. 값은 features/location/constants 한 곳)
//   · 위치 기록 — 위치 값을 쓰면 그 참여 조건의 출발 · 도착 알람에 alarm_events(ACKNOWLEDGED · ARRIVAL_CONFIRMED, input_source LOCATION)도 남김 (7.13.7 전송)
//     → 기록 화면 "집 출발 · 자동 · 지오펜스" 줄 (records/map.ts). 알람 행이 없으면(alarm_id 필수) 안 남김. 번호(client_event_id)는 참여 조건 · 종류 · 시각으로 고정
//     응답이 위치 값을 덮어도 위치 기록 줄은 남김 — 감지된 일 자체는 있었으므로 (근거 없음 — 작성자 판단). [아니에요] · 귀가 취소 때만 지움
//   · 준비 실측 — 출발 시각이 들어오면 daily_records.actual_prepare_minutes = 출발 − max(실제 기상 wake_confirmed_at, 예정 기상 = 그날 기상 알람 시각) (#41, B). 출처와 상관없이
//     하루에 한 번만(이미 값이 있으면 덮지 않음 — 같은 날 약속이 여러 개여도 먼저 들어온 출발이 준비 실측). 단 같은 참여 조건의 출발이 응답으로 바뀌어 그 출발로 셈한 값이면 새 출발로 다시 셈
//   · 실제 이동시간 — 출발 · 도착이 둘 다 있으면(출처 무관) actual_travel_minutes = 도착 − 출발(분). 쓰기만 하고 이동 보정 학습(7.3.1)은 L1 몫
//     출발지(비면 집) · 목적지 좌표가 없거나 500m 안이면 안 씀 (D68 · L6 안건후보: 가까운 약속 감지 기본안 — features/location/geo isNearTrip과 같은 규칙)
//     출발이 출발 예정 60분 전보다 이르면 안 씀 — 7.13.7 감시 창 따름 (집 이탈은 오늘 첫 약속에 시간 제한 없이 붙어 출발 · 도착이 몇 시간 떨어질 수 있음)
//   · 위치 값 지우기(clearLocationTime) — 사용자 정정 [아니에요](D61)와 귀가 취소(L6 안건후보: 집 이탈 약속 붙이기 기본안)가 같은 길을 씀. 출처가 LOCATION일 때만
//   · 같은 입력으로 다시 불려도 같은 결과 (onEventsUploaded 훅 · 위치 보관함이 던지면 다시 넘어오므로)
// 판정은 순수 함수(시험: __tests__/participantTimes.test.ts), 아래 recordParticipantTimes · clearLocationTime이 DB를 읽고 씀
import { LOCATION_HOLD_AFTER_MINUTES, LOCATION_HOLD_BEFORE_MINUTES } from '@/features/location/constants';
import { isNearTrip, toLatLng, type LatLng } from '@/features/location/geo';
import { detectionWindow, plannedDepartAt } from '@/features/location/regions';
import { dbTimeMs } from '@/lib/dbTime';
import { addDays, dayKey, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import { stableUuid } from '@/lib/uuid';
import type { Enums } from '@/types/database';

// 출발 · 도착이 어디서 왔는지 — alarm_events.input_source의 일부
export type TimeSource = Extract<Enums<'event_input_source'>, 'BUTTON' | 'MANUAL' | 'LOCATION'>;
// 출발 · 도착 중 어느 쪽 (features/location transitions의 DEPART · ARRIVE와 같은 이름)
export type TimeKind = 'DEPART' | 'ARRIVE';

// 사용자가 직접 알려 준 것 (원탭 · 직접 입력)
export const isResponse = (source: TimeSource): boolean => source !== 'LOCATION';

// 약속 시각보다 이만큼(분)을 넘어서 도착하면 지각 — D58 · #41 ("+5분 넘으면 지각"). 응답으로 받은 도착의 기준
export const LATE_AFTER_MINUTES = 5;
// D58 원탭 확인 구간(−2 ~ +5분)의 앞 끝. 위치 도착 보류 구간의 앞 끝(LOCATION_HOLD_BEFORE_MINUTES)이 이 값을 따름 — 위치 판정은 location 상수로 함
export const ON_TIME_BEFORE_MINUTES = 2;

// isLate / lateMinutes가 null이면 판정 보류 (appointment_participants.is_late · late_minutes는 NULL 허용 — 도착 확인이 없으면 NULL, 4.7)
export type ArrivalJudgment = { isLate: boolean | null; lateMinutes: number | null };

export function judgeArrival(arrivedAtMs: number, appointmentAtMs: number, source: TimeSource = 'BUTTON'): ArrivalJudgment {
  const diffMinutes = (arrivedAtMs - appointmentAtMs) / 60_000;
  // 응답으로 받은 도착은 사용자 말 그대로 +5분, 위치로 잡은 도착은 감지 지연만큼 넓힌 +11분
  const lateAfter = isResponse(source) ? LATE_AFTER_MINUTES : LOCATION_HOLD_AFTER_MINUTES;
  if (diffMinutes > lateAfter) return { isLate: true, lateMinutes: Math.round(diffMinutes) };
  if (isResponse(source) || diffMinutes < -LOCATION_HOLD_BEFORE_MINUTES) return { isLate: false, lateMinutes: 0 };
  return { isLate: null, lateMinutes: null };
}

// 지금 들어 있는 값의 출처 — 시각이 없으면 null, 출처 칸이 비면 옛 앱 원탭 값이라 BUTTON
export function storedSource(time: string | null, source: Enums<'event_input_source'> | null): Enums<'event_input_source'> | null {
  if (time == null) return null;
  return source ?? 'BUTTON';
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

// 실제 이동시간(분) — 못 쓰면 null: 좌표 없음 · 500m 안(가까운 약속) · 출발이 감시 창(출발 예정 60분 전)보다 이름 · 도착이 출발보다 빠름
//   departAtMs = 출발 예정 (출발 알람 시각, 없으면 약속 − 여유 − 이동 — features/location/regions와 같은 정의)
export function travelMinutesOf(t: {
  departedAtMs: number;
  arrivedAtMs: number;
  origin: LatLng | null;
  dest: LatLng | null;
  departAtMs: number;
  appointmentAtMs: number;
}): number | null {
  if (!t.origin || !t.dest || isNearTrip(t.origin, t.dest)) return null;
  // 7.13.7 감시 창 따름 — 창이 열리기 전 출발(오전에 집을 나가 저녁 약속에 붙은 이탈 등)은 이동시간이 아님
  if (t.departedAtMs < detectionWindow({ departAt: t.departAtMs, appointmentAt: t.appointmentAtMs }).start) return null;
  const minutes = Math.round((t.arrivedAtMs - t.departedAtMs) / 60_000);
  return minutes > 0 ? minutes : null;
}

// 위치 기록(alarm_events)의 번호 — 같은 참여 조건 · 종류 · 시각이면 같은 번호 (다시 불려도 한 줄, 지울 때도 이 번호로 찾음)
export const geoEventId = (participantId: string, kind: TimeKind, atMs: number): string => stableUuid('geo', participantId, kind, atMs);

// 종류별 알람 · 기록 모양 (원탭과 같음 — alarm-core plan.ts)
const KIND_ALARM = { DEPART: 'DEPARTURE', ARRIVE: 'ARRIVE' } as const;
const KIND_EVENT = { DEPART: 'ACKNOWLEDGED', ARRIVE: 'ARRIVAL_CONFIRMED' } as const;

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
  travelMinutes: number | null; // 이번에 쓴 실제 이동시간 (안 썼거나 같은 값이면 null)
};

const toMs = (value: Date | number | undefined): number | null => (value == null ? null : typeof value === 'number' ? value : value.getTime());
const iso = (ms: number) => new Date(ms).toISOString();

// 참여 조건 한 줄 — 시각 · 출처 · 좌표 · 출발 예정 계산 값, 약속(시각 · 목적지), 이 참여 조건의 알람(출발 · 도착 알람 id · 시각)
async function loadParticipant(userId: string, participantId: string) {
  const { data, error } = await supabase
    .from('appointment_participants')
    .select(
      'participant_id, appointment_id, departed_at, departed_source, arrived_at, arrived_source, actual_travel_minutes, origin_lat, origin_lng, est_travel_minutes, buffer_minutes, appointments(appointment_at, dest_lat, dest_lng), alarms(alarm_id, alarm_type, scheduled_at)',
    )
    .eq('participant_id', participantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
type ParticipantRow = NonNullable<Awaited<ReturnType<typeof loadParticipant>>>;

const alarmOf = (row: ParticipantRow, kind: TimeKind) => (row.alarms ?? []).find((a) => a.alarm_type === KIND_ALARM[kind]) ?? null;

// 그날 기상 기록 — 준비 실측의 기준 (daily_records 행 · 실제 기상 · 예정 기상)
async function loadPrepareBases(userId: string, departedAtMs: number) {
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
  return {
    record: record.data,
    confirmedMs: record.data?.wake_confirmed_at ? dbTimeMs(record.data.wake_confirmed_at) : null,
    scheduledMs: wake.data?.[0] ? dbTimeMs(wake.data[0].scheduled_at) : null,
  };
}

// 준비 실측을 그날 daily_records에 씀. 쓴 값(분)을 돌려주고, 안 썼으면 null
async function recordPrepareMinutes(userId: string, departedAtMs: number, previousDepartedAtMs: number | null): Promise<number | null> {
  const departed = new Date(departedAtMs);
  const { record, confirmedMs, scheduledMs } = await loadPrepareBases(userId, departedAtMs);
  const minutes = prepareMinutesOf(departedAtMs, confirmedMs, scheduledMs);
  if (minutes == null) return null;
  const existing = record?.actual_prepare_minutes ?? null;
  const fromPrevious = previousDepartedAtMs == null ? null : prepareMinutesOf(previousDepartedAtMs, confirmedMs, scheduledMs);
  if (!mayWritePrepare(existing, fromPrevious) || existing === minutes) return null;

  if (!record) {
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

// 이 출발로 셈한 준비 실측이면 비움 — 덮어쓰기(mayWritePrepare)와 같은 판단: 지금 값이 이 출발로 셈한 값과 같을 때만, 읽은 값 그대로일 때만
//   어느 출발로 셈했는지 남기는 칸이 없어 값으로 알아봄 (근거 없음 — 작성자 판단, 덮어쓰기 규칙과 같게)
//   다른 출발로 셈한 값(같은 날 다른 약속)은 그대로. 비운 뒤 원탭 출발이 들어오면 빈 칸이라 새로 셈함
async function revertPrepareMinutes(userId: string, departedAtMs: number): Promise<void> {
  const { record, confirmedMs, scheduledMs } = await loadPrepareBases(userId, departedAtMs);
  const fromThis = prepareMinutesOf(departedAtMs, confirmedMs, scheduledMs);
  const existing = record?.actual_prepare_minutes ?? null;
  if (fromThis == null || existing !== fromThis) return;
  const { error } = await supabase
    .from('daily_records')
    .update({ actual_prepare_minutes: null })
    .eq('user_id', userId)
    .eq('record_date', dayKey(new Date(departedAtMs)))
    .eq('actual_prepare_minutes', existing);
  if (error) throw error;
}

// 위치 기록 — 출발 알람에 ACKNOWLEDGED · 도착 알람에 ARRIVAL_CONFIRMED (input_source LOCATION). 같은 번호면 무시 (alarmSync uploadEvents와 같은 방식)
//   서버 쪽에서 이 기록에 반응하는 곳 없음: 그룹 기상 신호 트리거 · 미확인 배치 · 그룹 기상 현황은 기상 알람 기록만 봄, 폰 맞추기는 폰 기록을 올리기만 함
async function recordGeoEvents(userId: string, row: ParticipantRow, items: readonly { kind: TimeKind; atMs: number }[]): Promise<void> {
  const rows = items.flatMap(({ kind, atMs }) => {
    const alarm = alarmOf(row, kind);
    if (!alarm) return [];
    return [
      {
        alarm_id: alarm.alarm_id,
        user_id: userId,
        event_type: KIND_EVENT[kind],
        event_at: iso(atMs),
        input_source: 'LOCATION' as const,
        client_event_id: geoEventId(row.participant_id, kind, atMs),
      },
    ];
  });
  if (!rows.length) return;
  const { error } = await supabase.from('alarm_events').upsert(rows, { onConflict: 'client_event_id', ignoreDuplicates: true });
  if (error) throw error;
}

async function loadHome(userId: string): Promise<LatLng | null> {
  const { data, error } = await supabase.from('profiles').select('home_lat, home_lng').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return toLatLng({ lat: data?.home_lat, lng: data?.home_lng });
}

// 실제 이동시간을 씀. 쓴 값(분)을 돌려주고, 못 쓰거나 이미 같은 값이면 null. 출발 · 도착이 읽은 값 그대로일 때만
async function recordTravelMinutes(userId: string, row: ParticipantRow, departedAtMs: number, arrivedAtMs: number): Promise<number | null> {
  const appointment = row.appointments;
  if (!appointment?.appointment_at) return null;
  const dest = toLatLng({ lat: appointment.dest_lat, lng: appointment.dest_lng });
  if (!dest) return null;
  const origin = toLatLng({ lat: row.origin_lat, lng: row.origin_lng }) ?? (await loadHome(userId));
  const appointmentAtMs = dbTimeMs(appointment.appointment_at);
  const departureAlarm = alarmOf(row, 'DEPART');
  const departAtMs = departureAlarm
    ? dbTimeMs(departureAlarm.scheduled_at)
    : plannedDepartAt({ appointmentAt: appointmentAtMs, travelMinutes: row.est_travel_minutes, bufferMinutes: row.buffer_minutes });
  const minutes = travelMinutesOf({ departedAtMs, arrivedAtMs, origin, dest, departAtMs, appointmentAtMs });
  if (minutes == null || minutes === row.actual_travel_minutes) return null;
  const { error } = await supabase
    .from('appointment_participants')
    .update({ actual_travel_minutes: minutes })
    .eq('participant_id', row.participant_id)
    .eq('user_id', userId)
    .eq('departed_at', iso(departedAtMs))
    .eq('arrived_at', iso(arrivedAtMs));
  if (error) throw error;
  return minutes;
}

// 출발 · 도착 시각 기록. 일시 오류(네트워크 등)는 던짐 — 부르는 쪽이 다시 부를 수 있게 (같은 입력이면 같은 결과)
export async function recordParticipantTimes(input: RecordTimesInput): Promise<RecordTimesResult> {
  const result: RecordTimesResult = { departed: null, arrived: null, prepareMinutes: null, travelMinutes: null };
  const departedMs = toMs(input.departedAt);
  const arrivedMs = toMs(input.arrivedAt);
  if (departedMs == null && arrivedMs == null) return result;
  const userId = await requireUserId();

  const row = await loadParticipant(userId, input.participantId);
  if (!row) return result; // 지워진 참여 조건

  const isLocation = input.source === 'LOCATION';
  const geo: { kind: TimeKind; atMs: number }[] = []; // 남길 위치 기록
  const byResponse = (source: Enums<'event_input_source'> | null) => source != null && source !== 'LOCATION';

  const departedSource = storedSource(row.departed_at, row.departed_source);
  const storedDepartedMs = row.departed_at == null ? null : dbTimeMs(row.departed_at);
  let finalDepartedMs = storedDepartedMs;
  let replacedDepartedMs: number | null = null;
  if (departedMs != null) {
    const decision = decideWrite(input.source, { present: row.departed_at != null, byResponse: byResponse(departedSource) });
    result.departed = decision;
    if (decision !== 'keep') {
      const update = supabase.from('appointment_participants').update({ departed_at: iso(departedMs), departed_source: input.source }).eq('participant_id', input.participantId).eq('user_id', userId);
      // 읽은 뒤 그 사이 다른 곳이 쓴 값을 덮지 않게 읽은 값 그대로일 때만
      const { error } = await (decision === 'new' ? update.is('departed_at', null) : update.eq('departed_at', row.departed_at as string));
      if (error) throw error;
      finalDepartedMs = departedMs;
      if (decision === 'override') replacedDepartedMs = storedDepartedMs;
    }
    // 이번에 쓴 위치 값, 또는 앞 시도가 쓰고 기록을 남기기 전에 끊긴 같은 값 (다시 불려도 같은 결과)
    if (isLocation && (decision !== 'keep' || (departedSource === 'LOCATION' && storedDepartedMs === departedMs))) geo.push({ kind: 'DEPART', atMs: departedMs });
  }

  const arrivedSource = storedSource(row.arrived_at, row.arrived_source);
  const storedArrivedMs = row.arrived_at == null ? null : dbTimeMs(row.arrived_at);
  let finalArrivedMs = storedArrivedMs;
  if (arrivedMs != null) {
    const decision = decideWrite(input.source, { present: row.arrived_at != null, byResponse: byResponse(arrivedSource) });
    result.arrived = decision;
    const appointmentAt = row.appointments?.appointment_at;
    if (decision !== 'keep') {
      // 약속 시각을 못 읽으면 지각은 보류 (도착 시각만 남김)
      const { isLate, lateMinutes } = appointmentAt ? judgeArrival(arrivedMs, dbTimeMs(appointmentAt), input.source) : { isLate: null, lateMinutes: null };
      const update = supabase
        .from('appointment_participants')
        .update({ arrived_at: iso(arrivedMs), arrived_source: input.source, is_late: isLate, late_minutes: lateMinutes })
        .eq('participant_id', input.participantId)
        .eq('user_id', userId);
      const { error } = await (decision === 'new' ? update.is('arrived_at', null) : update.eq('arrived_at', row.arrived_at as string));
      if (error) throw error;
      finalArrivedMs = arrivedMs;
    }
    if (isLocation && (decision !== 'keep' || (arrivedSource === 'LOCATION' && storedArrivedMs === arrivedMs))) geo.push({ kind: 'ARRIVE', atMs: arrivedMs });
  }

  if (geo.length) await recordGeoEvents(userId, row, geo);
  if (departedMs != null && finalDepartedMs != null) result.prepareMinutes = await recordPrepareMinutes(userId, finalDepartedMs, replacedDepartedMs);
  if (finalDepartedMs != null && finalArrivedMs != null) result.travelMinutes = await recordTravelMinutes(userId, row, finalDepartedMs, finalArrivedMs);
  return result;
}

// 위치로 쓴 값 하나 — 지우기 · 되돌리기에 씀 (at = 저장된 시각 ms, alarmId = 그 종류의 알람 · 없으면 null)
export type LocationTime = { participantId: string; kind: TimeKind; at: number; appointmentId: string; alarmId: string | null };

// 지금 값이 위치(LOCATION)일 때만 돌려줌 — 빈 칸 · 응답 값(옛 앱 원탭 포함) · 지워진 참여 조건은 null
export async function readLocationTime(participantId: string, kind: TimeKind): Promise<LocationTime | null> {
  const userId = await requireUserId();
  const row = await loadParticipant(userId, participantId);
  if (!row) return null;
  const time = kind === 'DEPART' ? row.departed_at : row.arrived_at;
  const source = kind === 'DEPART' ? row.departed_source : row.arrived_source;
  if (time == null || storedSource(time, source) !== 'LOCATION') return null;
  return { participantId, kind, at: dbTimeMs(time), appointmentId: row.appointment_id, alarmId: alarmOf(row, kind)?.alarm_id ?? null };
}

// 위치 값 지우기 — 그 출발로 셈한 준비 실측 · 위치 기록(alarm_events)을 먼저 지우고, 시각 · 출처(도착이면 지각 판정도) · 실제 이동시간을 맨 나중에 비움
//   순서 까닭: 중간에 끊겨도 시각이 남아 다시 부를 수 있게 (시각을 먼저 비우면 다시 불러도 위치 값이 아니라서 학습에 들어가는 준비 실측이 남음)
//   시각은 읽은 값 그대로 · 출처 LOCATION일 때만 비움 — 그 사이 원탭이 덮었으면 그대로 두고 false. 위치 기록 지우기는 RLS alarm_events_delete_own(본인 기록)
export async function clearLocationTime(found: LocationTime): Promise<boolean> {
  const userId = await requireUserId();
  if (found.kind === 'DEPART') await revertPrepareMinutes(userId, found.at);
  const removed = await supabase.from('alarm_events').delete().eq('user_id', userId).eq('client_event_id', geoEventId(found.participantId, found.kind, found.at));
  if (removed.error) throw removed.error;

  const at = iso(found.at);
  const update =
    found.kind === 'DEPART'
      ? supabase.from('appointment_participants').update({ departed_at: null, departed_source: null, actual_travel_minutes: null }).eq('departed_at', at).eq('departed_source', 'LOCATION')
      : supabase
          .from('appointment_participants')
          .update({ arrived_at: null, arrived_source: null, is_late: null, late_minutes: null, actual_travel_minutes: null })
          .eq('arrived_at', at)
          .eq('arrived_source', 'LOCATION');
  const { data, error } = await update.eq('participant_id', found.participantId).eq('user_id', userId).select('participant_id');
  if (error) throw error;
  return (data ?? []).length > 0;
}
