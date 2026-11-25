// ① 약속 기반 알람 — 실데이터 읽기 쿼리 모음 (얇게). 행 → 화면 타입 변환은 map.ts
//   "내 것"은 호출하는 쪽이 넘긴 userId(lib/user requireUserId)로 한 번 더 좁힘 — RLS는 친구에게 받은 알람 · 같은 그룹 약속도 보여 주므로
//   읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
import { levelOfVoiceTone, wakeSensitivityOf, type WakeSensitivity } from '@shared/calc/intensity.ts';

import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

import { toAppointmentDetail, type AlarmRow, type AppointmentRows, type OccurrenceRow, type StandaloneRow } from './map';
import type { AppointmentDetail, Level } from './types';

// 참여 조건 하나 + 약속 + 그룹 이름 + 이 참여 조건의 알람 전부 (꺼진 것 · 도착 목표 포함). appointments!inner = 약속이 있는 참여 조건만, 약속 날짜로 거를 수 있음
const PARTICIPANT_SELECT =
  'participant_id, origin_name, transport_type, est_travel_minutes, travel_source, prepare_minutes, prepare_value_source, buffer_minutes, appointments!inner(appointment_id, series_id, title, appointment_at, dest_name, dest_lat, dest_lng, importance, recurrence_rule, groups(group_name)), alarms(alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, time_source, intensity_source)';

// 이번만 지운 회차(appointments.exception_kind = 'CANCELED', 서버 appointment-edit)는 행은 남아 있고 알람만 지워져 있음 — H01 하루 일정(알람 없는 일정 줄) · H02 · 회차 목록에 안 보여야 함.
//   NULL은 `neq`에 안 걸려서 is.null을 같이 씀. 약속 쪽 칸이라 `appointments!inner` 임베드에 referencedTable로 걺 (그래야 참여 조건 줄이 통째로 빠짐).
//   database.ts(Actions가 만드는 파일)에 exception_kind가 아직 없어도 타입 오류가 없게 문자열 필터로 씀
export const NOT_CANCELED = 'exception_kind.is.null,exception_kind.neq.CANCELED';
const EMBED = { referencedTable: 'appointments' } as const;

// 목록 상한 — 넘으면 가까운 날짜부터 LIST_LIMIT개만 (정렬 없이 limit하면 어느 줄이 오는지 정해지지 않으므로 날짜순으로 정렬한 뒤 자름)
//   약속 쪽은 PostgREST가 to-one 임베드 칸으로 정렬하는 `appointments(appointment_at)` 형식(PostgREST 11 이상)
const LIST_LIMIT = 300;
const OCCURRENCE_LIMIT = 60; // 회차 목록 상한 — 서버가 14일치만 미리 만들어서 넉넉한 값 (매일 반복이어도 14줄)

// select 결과 한 줄 (타입 붙은 클라이언트가 만든 모양 중 쓰는 칸)
type ParticipantQueryRow = {
  participant_id: string;
  origin_name: string | null;
  transport_type: AppointmentRows['participant']['transport_type'];
  est_travel_minutes: number | null;
  travel_source: AppointmentRows['participant']['travel_source'];
  prepare_minutes: number;
  // PostgREST infers SQL CHECK-constrained text as plain string.
  // Normalize at the boundary instead of asserting a narrower type.
  prepare_value_source?: string | null;
  buffer_minutes: number;
  appointments: AppointmentRows['appointment'] & { groups: { group_name: string } | null };
  alarms: AlarmRow[];
};

// 쿼리가 이미 내 참여 조건만 읽음. 공동 약속은 그룹원 누구나 고치므로(#619) 만든 사람은 안 읽음
export function toRows(row: ParticipantQueryRow, items: ReadonlyMap<string, string[]>): AppointmentRows {
  const { appointments: appointment, alarms, prepare_value_source, ...participant } = row;
  // Unknown historic/database values are not automatically inferred as AUTO.
  // Preserve only explicitly known values; fall back to LEGACY otherwise.
  const safePrepareSource = prepare_value_source === 'AUTO' ||
    prepare_value_source === 'MANUAL' ||
    prepare_value_source === 'LEGACY' ? prepare_value_source : 'LEGACY';
  const { groups, ...appointmentColumns } = appointment;
  return {
    appointment: appointmentColumns,
    participant: { ...participant, prepare_value_source: safePrepareSource },
    alarms,
    groupName: groups?.group_name ?? null,
    items: items.get(appointment.appointment_id) ?? [],
  };
}

// .in() 한 번에 넣는 id 수 — PostgREST는 id를 주소(GET 쿼리)에 실어 보내는데 UUID가 36자라 목록 상한(300)만큼이면 약 11,000자로 주소 길이 한도(보통 8KB 안팎)를 넘길 수 있음
export const IN_CHUNK = 100;

export function chunked<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 준비물(todos ITEM) — 약속별로 모음. 약속 id가 많으면 IN_CHUNK개씩 나눠 읽음 (한 약속의 준비물은 한 묶음 안에 있어 순서는 그대로)
export async function fetchItems(userId: string, appointmentIds: readonly string[]): Promise<Map<string, string[]>> {
  const byAppointment = new Map<string, string[]>();
  const pages = await Promise.all(
    chunked(appointmentIds).map(async (ids) => {
      const { data, error } = await supabase.from('todos').select('appointment_id, title').eq('user_id', userId).eq('todo_type', 'ITEM').in('appointment_id', ids).order('created_at');
      if (error) throw error;
      return data ?? [];
    }),
  );
  for (const todo of pages.flat()) {
    if (!todo.appointment_id) continue;
    byAppointment.set(todo.appointment_id, [...(byAppointment.get(todo.appointment_id) ?? []), todo.title]);
  }
  return byAppointment;
}

// 내 참여 조건 하나의 약속 · 알람 전부 · 그룹 이름 · 준비물 — 참여 조건 id로 (홈 다음 알람이 알람에서 거슬러 올라올 때)
export async function loadAppointmentRows(participantId: string, userId: string): Promise<AppointmentRows | null> {
  const { data, error } = await supabase.from('appointment_participants').select(PARTICIPANT_SELECT).eq('participant_id', participantId).eq('user_id', userId).or(NOT_CANCELED, EMBED).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toRows(data, await fetchItems(userId, [data.appointments.appointment_id]));
}

// 같은 것을 약속 id로 (H03 — 화면 주소가 약속 id). 내 것이 아니거나(RLS) 없으면 null
export async function loadAppointmentRowsByAppointment(appointmentId: string, userId: string): Promise<AppointmentRows | null> {
  if (!isUuid(appointmentId)) return null; // 가짜 데이터 시절 주소(m1)가 남아 있어도 DB 형식 오류 대신 "없음"
  const { data, error } = await supabase.from('appointment_participants').select(PARTICIPANT_SELECT).eq('appointment_id', appointmentId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toRows(data, await fetchItems(userId, [appointmentId]));
}

// since(ISO) 이후 약속의 내 참여 조건 전부 (H02 목록)
export async function loadAppointmentRowsSince(userId: string, since: string): Promise<AppointmentRows[]> {
  const { data, error } = await supabase
    .from('appointment_participants')
    .select(PARTICIPANT_SELECT)
    .eq('user_id', userId)
    .gte('appointments.appointment_at', since)
    .or(NOT_CANCELED, EMBED)
    .order('appointments(appointment_at)')
    .limit(LIST_LIMIT);
  if (error) throw error;
  const rows = data ?? [];
  const items = await fetchItems(userId, rows.map((r) => r.appointments.appointment_id));
  return rows.map((row) => toRows(row, items));
}

// [from, to) 안 약속의 내 참여 조건 — 하루 일정 한 줄(H01)과 오늘 첫 일정(기상 후 아침 흐름)이 같이 읽음.
//   알람은 종류 · 시각 · 켜짐까지, 참여 조건은 예상 이동 · 출처 · 출발 기록까지 (오늘 첫 일정 = 켜진 기상 알람이 붙은 가장 이른 약속)
async function fetchDayRows(userId: string, from: string, to: string) {
  const { data, error } = await supabase
    .from('appointment_participants')
    .select(
      'participant_id, est_travel_minutes, travel_source, departed_at, arrived_at, appointments!inner(appointment_id, title, appointment_at, dest_name, importance), alarms(alarm_id, alarm_type, scheduled_at, is_enabled)',
    )
    .eq('user_id', userId)
    .gte('appointments.appointment_at', from)
    .lt('appointments.appointment_at', to)
    .or(NOT_CANCELED, EMBED)
    .order('appointments(appointment_at)')
    .limit(LIST_LIMIT);
  if (error) throw error;
  return data ?? [];
}

// 홈이 하루 일정과 오늘 첫 일정을 한꺼번에 부르므로(Promise.all) 같은 하루를 동시에 두 번 묻지 않게 한 번만 — 끝나면 기억하지 않음 (realPlan suggest와 같은 방식)
const dayReads = new Map<string, ReturnType<typeof fetchDayRows>>();

export function loadDayRows(userId: string, from: string, to: string) {
  const key = [userId, from, to].join('|');
  const running = dayReads.get(key);
  if (running) return running;
  const task = fetchDayRows(userId, from, to).finally(() => dayReads.delete(key));
  dayReads.set(key, task);
  return task;
}

// 일정 없는 알람(D46) — 약속 · 루틴과 안 이어진 기상 알람. since(ISO)보다 이전 시각은 안 읽음. 목록(H02)이 반복 묶음당 하나만 보이려고 series_id도 읽음
export async function loadStandaloneRows(userId: string, since: string): Promise<StandaloneRow[]> {
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, series_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, time_source, intensity_source, recurrence_rule')
    .eq('user_id', userId)
    .eq('alarm_type', 'WAKE')
    .is('participant_id', null)
    .is('routine_id', null)
    .gte('scheduled_at', since)
    .order('scheduled_at')
    .limit(LIST_LIMIT);
  if (error) throw error;
  return data ?? [];
}

// 일정 없는 알람 하나 (내 것만)
export async function loadStandaloneRow(userId: string, alarmId: string): Promise<StandaloneRow | null> {
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, time_source, intensity_source, recurrence_rule')
    .eq('user_id', userId)
    .eq('alarm_id', alarmId)
    .is('participant_id', null)
    .is('routine_id', null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// 반복 일정의 앞으로 회차 (H03) — 이 약속과 같은 묶음(series_id)의 내 참여 조건 중 since(ISO) 이후. 묶음 번호가 없으면(반복이 아님) 빈 목록
//   회차 하나는 알람 시각만 있으면 되어 알람은 종류 · 시각 · 켜짐만 읽음. 서버가 앞으로 14일치만 미리 만들어 두므로 많아야 14줄
export async function loadOccurrenceRows(appointmentId: string, userId: string, since: string): Promise<OccurrenceRow[]> {
  if (!isUuid(appointmentId)) return []; // 가짜 데이터 시절 주소가 남아 있어도 DB 형식 오류 대신 "없음"
  const { data: own, error: ownError } = await supabase.from('appointments').select('series_id').eq('appointment_id', appointmentId).maybeSingle();
  if (ownError) throw ownError;
  if (!own?.series_id) return [];
  const { data, error } = await supabase
    .from('appointment_participants')
    .select('appointments!inner(appointment_id, series_id, appointment_at), alarms(alarm_type, scheduled_at, is_enabled)')
    .eq('user_id', userId)
    .eq('appointments.series_id', own.series_id)
    .gte('appointments.appointment_at', since)
    .or(NOT_CANCELED, EMBED)
    .order('appointments(appointment_at)')
    .limit(OCCURRENCE_LIMIT);
  if (error) throw error;
  return (data ?? []).map((row) => ({ appointment: row.appointments, alarms: row.alarms }));
}

const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;

// 최근 4주 지각 횟수 — 서버(plan.ts loadLateCount)와 같은 조건: is_late = true, 도착 시각이 4주 안. 강도 자동 값에 씀
//   늦잠이 원인인 지각만 세는 칸(late_cause)은 DB에 없어 지각 전체로 셈 (서버도 같음)
export async function fetchLateCount(userId: string, nowMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('appointment_participants')
    .select('participant_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_late', true)
    .gte('arrived_at', new Date(nowMs - FOUR_WEEKS_MS).toISOString());
  if (error) throw error;
  return count ?? 0;
}

// 내 잠귀 (온보딩 한 문항, profiles.wake_sensitivity) — 강도 자동 값에 씀. 서버 plan.ts loadProfile + wakeSensitivityOf와 같은 규칙: 무거움이면 HEAVY, 가벼움 · 보통 · 프로필 없음은 NORMAL
//   voiceDefault = 설정의 기본 말소리 (profiles.preferred_voice_tone) 단계, 비면 null(자동) — 서버 plan-core와 같은 규칙
export async function fetchIntensityPrefs(userId: string): Promise<{ wakeSensitivity: WakeSensitivity; voiceDefault: Level | null }> {
  const { data, error } = await supabase.from('profiles').select('wake_sensitivity, preferred_voice_tone').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return { wakeSensitivity: wakeSensitivityOf(data?.wake_sensitivity), voiceDefault: levelOfVoiceTone(data?.preferred_voice_tone) };
}

// 알람 설정(H03)이 읽는 약속 하나 — 저장된 값 · 직접 고른 값 · 강도. 약속이 없거나 내 것이 아니면 null (알람이 없는 약속은 호출하는 쪽이 거름)
export async function loadDetail(appointmentId: string, userId: string, nowMs: number): Promise<AppointmentDetail | null> {
  if (!isUuid(appointmentId)) return null; // 지각 횟수까지 묻기 전에 (loadAppointmentRowsByAppointment도 같은 확인을 함)
  const [rows, lateCount, prefs] = await Promise.all([loadAppointmentRowsByAppointment(appointmentId, userId), fetchLateCount(userId, nowMs), fetchIntensityPrefs(userId)]);
  return rows ? toAppointmentDetail(rows, lateCount, prefs.wakeSensitivity, prefs.voiceDefault) : null;
}
