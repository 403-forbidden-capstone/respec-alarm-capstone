// ① 약속 기반 알람 — 실데이터 읽기 쿼리 모음 (얇게). 행 → 화면 타입 변환은 map.ts
//   "내 것"은 호출하는 쪽이 넘긴 userId(lib/user requireUserId)로 한 번 더 좁힘 — RLS는 친구에게 받은 알람 · 같은 그룹 약속도 보여 주므로
//   읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

import { toAppointmentDetail, type AlarmRow, type AppointmentRows, type StandaloneRow } from './map';
import type { AppointmentDetail } from './types';

// 참여 조건 하나 + 약속 + 그룹 이름 + 이 참여 조건의 알람 전부 (꺼진 것 · 도착 목표 포함). appointments!inner = 약속이 있는 참여 조건만, 약속 날짜로 거를 수 있음
const PARTICIPANT_SELECT =
  'participant_id, origin_name, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes, appointments!inner(appointment_id, title, appointment_at, dest_name, importance, recurrence_rule, groups(group_name)), alarms(alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, is_enabled, time_source, intensity_source)';

// 목록 상한 — 넘으면 가까운 날짜부터 LIST_LIMIT개만 (정렬 없이 limit하면 어느 줄이 오는지 정해지지 않으므로 날짜순으로 정렬한 뒤 자름)
//   약속 쪽은 PostgREST가 to-one 임베드 칸으로 정렬하는 `appointments(appointment_at)` 형식(PostgREST 11 이상)
const LIST_LIMIT = 300;

// select 결과 한 줄 (타입 붙은 클라이언트가 만든 모양 중 쓰는 칸)
type ParticipantQueryRow = {
  participant_id: string;
  origin_name: string | null;
  transport_type: AppointmentRows['participant']['transport_type'];
  est_travel_minutes: number | null;
  travel_source: AppointmentRows['participant']['travel_source'];
  prepare_minutes: number;
  buffer_minutes: number;
  appointments: AppointmentRows['appointment'] & { groups: { group_name: string } | null };
  alarms: AlarmRow[];
};

function toRows(row: ParticipantQueryRow, items: ReadonlyMap<string, string[]>): AppointmentRows {
  const { appointments: appointment, alarms, ...participant } = row;
  const { groups, ...appointmentColumns } = appointment;
  return {
    appointment: appointmentColumns,
    participant,
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
  const { data, error } = await supabase.from('appointment_participants').select(PARTICIPANT_SELECT).eq('participant_id', participantId).eq('user_id', userId).maybeSingle();
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
    .order('appointments(appointment_at)')
    .limit(LIST_LIMIT);
  if (error) throw error;
  const rows = data ?? [];
  const items = await fetchItems(userId, rows.map((r) => r.appointments.appointment_id));
  return rows.map((row) => toRows(row, items));
}

// [from, to) 안 약속의 내 참여 조건 — 알람이 있는지만 알면 되는 하루 일정 한 줄용 (H01)
export async function loadDayRows(userId: string, from: string, to: string) {
  const { data, error } = await supabase
    .from('appointment_participants')
    .select('participant_id, appointments!inner(appointment_id, title, appointment_at, dest_name, importance), alarms(alarm_id, alarm_type)')
    .eq('user_id', userId)
    .gte('appointments.appointment_at', from)
    .lt('appointments.appointment_at', to)
    .order('appointments(appointment_at)')
    .limit(LIST_LIMIT);
  if (error) throw error;
  return data ?? [];
}

// 일정 없는 알람(D46) — 약속 · 루틴과 안 이어진 기상 알람. since(ISO)보다 이전 시각은 안 읽음
export async function loadStandaloneRows(userId: string, since: string): Promise<StandaloneRow[]> {
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, is_enabled, time_source, intensity_source, recurrence_rule')
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
    .select('alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, is_enabled, time_source, intensity_source, recurrence_rule')
    .eq('user_id', userId)
    .eq('alarm_id', alarmId)
    .is('participant_id', null)
    .is('routine_id', null)
    .maybeSingle();
  if (error) throw error;
  return data;
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

// 알람 설정(H03)이 읽는 약속 하나 — 저장된 값 · 직접 고른 값 · 강도. 약속이 없거나 내 것이 아니면 null (알람이 없는 약속은 호출하는 쪽이 거름)
export async function loadDetail(appointmentId: string, userId: string, nowMs: number): Promise<AppointmentDetail | null> {
  if (!isUuid(appointmentId)) return null; // 지각 횟수까지 묻기 전에 (loadAppointmentRowsByAppointment도 같은 확인을 함)
  const [rows, lateCount] = await Promise.all([loadAppointmentRowsByAppointment(appointmentId, userId), fetchLateCount(userId, nowMs)]);
  return rows ? toAppointmentDetail(rows, lateCount) : null;
}
