// ① 약속 기반 알람 — 실데이터(Supabase) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6)
//   · 읽기 쿼리는 realRows.ts에서 얇게, 행 → 화면 타입 변환은 map.ts(순수 함수 · 시험 있음)
//   · 돌려주는 모양은 types.ts 그대로 — 화면 파일은 되도록 안 고침. 읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
//   · "내 것"은 lib/user requireUserId()의 user_id로 한 번 더 좁힘 (RLS는 친구에게 받은 알람도 보여 주므로)
//   · 시각은 lib/clock now() (실데이터 모드에서는 지금 시각)
//   · 쓰기: 일정 전체 켜기 · 끄기 = DB 직접 → 그 알람만 reconcile (realWrite.ts), 계산 · 저장(H03의 종류별 켜기 · 강도 포함, H05) = alarm-suggest · alarm-commit → applyCommit (realPlan.ts),
//     울림 · 기상 확인 = 알람 코어 + alarm_events (realWake.ts). screen-data-map "실데이터 연결 규칙"
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { addDays, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { rememberDetail } from './detailCache';
import { byTime, hasAlarms, listOnePerSeries, pickNextAlarm, toAppointment, toOccurrences, toScheduleItem, toStandaloneAppointment } from './map';
import { fetchIntensityPrefs, fetchLateCount, loadAppointmentRows, loadAppointmentRowsSince, loadDayRows, loadDetail, loadOccurrenceRows, loadStandaloneRow, loadStandaloneRows } from './realRows';
import type { Appointment, AppointmentDetail, NextAlarm, Occurrence, ScheduleItem, StandaloneWake } from './types';

export * from './realEdit';
export * from './realMorning';
export * from './realPlan';
export * from './realWake';
export { setAlarmEnabled, setAppointmentEnabled, setIntensity } from './realWrite';

// 알람 목록(H02)이 읽는 지난 일정 범위 — 오늘 0시보다 이만큼 앞까지 ("지난 일정"으로 접어 둠). 작성자 판단 — 되돌리기 쉬움
export const LIST_PAST_DAYS = 30;

// 새 일정(H05) 알람 강도 미리 보기 — 저장(alarm-commit)과 같은 입력: 최근 4주 지각 · 잠귀 · 기본 말소리
export async function getIntensityBasis() {
  const userId = await requireUserId();
  const [lateCount, prefs] = await Promise.all([fetchLateCount(userId, now().getTime()), fetchIntensityPrefs(userId)]);
  return { lateCount, ...prefs };
}

// H01 다음 알람 — 지금 이후 가장 먼저 울릴 켜진 알람(기상 · 준비 · 출발)이 있는 약속. 일정 없는 알람(D46)도 제목 "알람"으로 나옴. 루틴 알람은 NextAlarm이 약속 모양을 요구해 안 나옴
export async function getNextAlarm(): Promise<NextAlarm | null> {
  const userId = await requireUserId();
  const at = now();
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, participant_id')
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .in('alarm_type', ['WAKE', 'PREPARE', 'DEPARTURE'])
    .is('routine_id', null)
    .gte('scheduled_at', at.toISOString())
    .order('scheduled_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  if (data.participant_id) {
    const rows = await loadAppointmentRows(data.participant_id, userId);
    return rows ? pickNextAlarm([toAppointment(rows)], at.getTime()) : null;
  }
  const standalone = await loadStandaloneRow(userId, data.alarm_id);
  return standalone ? pickNextAlarm([toStandaloneAppointment(standalone)], at.getTime()) : null;
}

// 모든 일정의 알람 (H02) — 시각 순. 알람 없는 일정은 목록에 없고 H01 일정 줄에만 보임. 일정 없는 알람은 같이 섞여 나옴
//   반복은 묶음(series_id)당 지금 이후 가장 가까운 회차 하나 — 서버가 14일치 회차를 미리 만들어 두므로 다 보이면 같은 일정이 14장 (지난 회차도 안 보임). 앞으로 회차가 둘 이상이면 upcomingCount를 붙임
//   H01 · R02 · H03은 회차 행 그대로 (H01 하루 일정은 그날 회차만, 다음 알람은 가장 가까운 알람 하나만. 회차 목록은 H03의 listOccurrences)
//   everyOccurrence = 묶음을 줄이지 않고 모든 회차 (H05가 "같은 날 앞 일정의 기상"을 찾을 때 — 그날의 회차가 가장 가까운 회차가 아닐 수 있음)
export async function listAppointments(options: { everyOccurrence?: boolean } = {}): Promise<Appointment[]> {
  const userId = await requireUserId();
  const at = now();
  const since = addDays(startOfDay(at), -LIST_PAST_DAYS).toISOString();
  const [rows, standalone] = await Promise.all([loadAppointmentRowsSince(userId, since), loadStandaloneRows(userId, since)]);
  const entries = [
    ...rows.map((row) => ({ seriesId: row.appointment.series_id, item: toAppointment(row) })),
    ...standalone.map((row) => ({ seriesId: row.series_id, item: toStandaloneAppointment(row) })),
  ].filter((entry) => hasAlarms(entry.item));
  return options.everyOccurrence ? entries.map((entry) => entry.item).sort(byTime) : listOnePerSeries(entries, at.getTime());
}

// 하루 일정 (H01) — 알람 있는 일정 + 알람 없는 일정 (알람 없는 쪽은 hasAlarm이 false)
export async function getDaySchedule(day: Date): Promise<ScheduleItem[]> {
  const userId = await requireUserId();
  const from = startOfDay(day);
  const rows = await loadDayRows(userId, from.toISOString(), addDays(from, 1).toISOString());
  return rows.map((row) => toScheduleItem({ appointment: row.appointments, alarms: row.alarms })).sort(byTime);
}

// 알람 설정 (H03) — 알람 없는 일정 · 일정 없는 알람은 열 알람 설정이 없어 null
//   withoutAlarms: H03만 — 알람 없는 일정(장소 미정 · 장소를 나중에 정함)도 열어 장소를 정하고 알람을 만들 수 있게 (D41 A). 다른 곳은 알람 없으면 null 그대로
export async function getAppointment(id: string, options: { withoutAlarms?: boolean } = {}): Promise<AppointmentDetail | null> {
  const userId = await requireUserId();
  const detail = await loadDetail(id, userId, now().getTime());
  if (!detail || (!detail.alarms.length && !options.withoutAlarms)) return null;
  rememberDetail(detail);
  return detail;
}

// 그날(기기 시간대 0시부터) 이 일정 시각 전에 울릴 일정 없는 기상 알람 — 켜짐 · 아직 안 지남 · 반복 아님(매일 알람 같은 반복은 일부러 둔 것이라 묻지 않음)
export async function listStandaloneWakes(at: Date): Promise<StandaloneWake[]> {
  const userId = await requireUserId();
  const from = Math.max(startOfDay(at).getTime(), now().getTime());
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, scheduled_at')
    .eq('user_id', userId)
    .eq('alarm_type', 'WAKE')
    .eq('is_enabled', true)
    .is('participant_id', null)
    .is('routine_id', null)
    .is('recurrence_rule', null)
    .gte('scheduled_at', new Date(from).toISOString())
    .lt('scheduled_at', at.toISOString())
    .order('scheduled_at');
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.alarm_id, at: parseDbTime(r.scheduled_at) }));
}

// 반복 일정의 앞으로 회차 (H03 회차 목록) — 같은 묶음의 지금 이후 회차, 시각 순. 반복이 아니면 빈 목록
export async function listOccurrences(id: string): Promise<Occurrence[]> {
  const userId = await requireUserId();
  const at = now();
  return toOccurrences(await loadOccurrenceRows(id, userId, at.toISOString()), at.getTime());
}
