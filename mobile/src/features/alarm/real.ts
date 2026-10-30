// ① 약속 기반 알람 — 실데이터(Supabase) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6)
//   · 읽기 쿼리는 realRows.ts에서 얇게, 행 → 화면 타입 변환은 map.ts(순수 함수 · 시험 있음)
//   · 돌려주는 모양은 types.ts 그대로 — 화면 파일은 되도록 안 고침. 읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
//   · "내 것"은 lib/user requireUserId()의 user_id로 한 번 더 좁힘 (RLS는 친구에게 받은 알람도 보여 주므로)
//   · 시각은 lib/clock now() (실데이터 모드에서는 지금 시각)
//   · 쓰기: 일정 전체 켜기 · 끄기 = DB 직접 → 그 알람만 reconcile (realWrite.ts), 계산 · 저장(H03의 종류별 켜기 · 강도 포함, H05) = alarm-suggest · alarm-commit → applyCommit (realPlan.ts),
//     울림 · 기상 확인 = 알람 코어 + alarm_events (realWake.ts). screen-data-map "실데이터 연결 규칙"
import { now } from '@/lib/clock';
import { addDays, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { rememberDetail } from './detailCache';
import { byTime, hasAlarms, onePerSeries, pickNextAlarm, toAppointment, toScheduleItem, toStandaloneAppointment } from './map';
import { loadAppointmentRows, loadAppointmentRowsSince, loadDayRows, loadDetail, loadStandaloneRow, loadStandaloneRows } from './realRows';
import type { Appointment, AppointmentDetail, NextAlarm, ScheduleItem } from './types';

export * from './realPlan';
export * from './realWake';
export { setAlarmEnabled, setAppointmentEnabled, setIntensity } from './realWrite';

// 알람 목록(H02)이 읽는 지난 일정 범위 — 오늘 0시보다 이만큼 앞까지 ("지난 일정"으로 접어 둠). 작성자 판단 — 되돌리기 쉬움
export const LIST_PAST_DAYS = 30;

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
//   반복은 묶음(series_id)당 지금 이후 가장 가까운 회차 하나 — 서버가 14일치 회차를 미리 만들어 두므로 다 보이면 같은 일정이 14장 (지난 회차도 안 보임). H01 · R02 · H03은 회차 행 그대로
export async function listAppointments(): Promise<Appointment[]> {
  const userId = await requireUserId();
  const at = now();
  const since = addDays(startOfDay(at), -LIST_PAST_DAYS).toISOString();
  const [rows, standalone] = await Promise.all([loadAppointmentRowsSince(userId, since), loadStandaloneRows(userId, since)]);
  const entries = [
    ...rows.map((row) => ({ seriesId: row.appointment.series_id, item: toAppointment(row) })),
    ...standalone.map((row) => ({ seriesId: row.series_id, item: toStandaloneAppointment(row) })),
  ].filter((entry) => hasAlarms(entry.item));
  return onePerSeries(entries, at.getTime()).sort(byTime);
}

// 하루 일정 (H01) — 알람 있는 일정 + 알람 없는 일정 (알람 없는 쪽은 hasAlarm이 false)
export async function getDaySchedule(day: Date): Promise<ScheduleItem[]> {
  const userId = await requireUserId();
  const from = startOfDay(day);
  const rows = await loadDayRows(userId, from.toISOString(), addDays(from, 1).toISOString());
  return rows.map((row) => toScheduleItem({ appointment: row.appointments, alarms: row.alarms })).sort(byTime);
}

// 알람 설정 (H03) — 알람 없는 일정 · 일정 없는 알람은 열 알람 설정이 없어 null
export async function getAppointment(id: string): Promise<AppointmentDetail | null> {
  const userId = await requireUserId();
  const detail = await loadDetail(id, userId, now().getTime());
  if (!detail || !detail.alarms.length) return null;
  rememberDetail(detail);
  return detail;
}
