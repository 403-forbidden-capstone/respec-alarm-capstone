// ① 약속 기반 알람 — 실데이터(Supabase) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6)
//   · 쿼리는 이 파일에서 얇게, 행 → 화면 타입 변환은 map.ts(순수 함수 · 시험 있음)
//   · 돌려주는 모양은 types.ts 그대로 — 화면 파일은 안 고침. 읽기 실패는 DB 원문 그대로 던지고(화면은 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
//   · "내 것"은 lib/user requireUserId()의 user_id로 한 번 더 좁힘 (RLS는 친구에게 받은 알람도 보여 주므로)
//   · 시각은 lib/clock now() (실데이터 모드에서는 지금 시각)
//   · 쓰기는 alarm-commit(lib/edge callEdge) -> 결과를 폰에 반영(lib/alarmSync applyCommit), 켜기 · 끄기 같은 직접 쓰기는 DB -> 그 알람만 reconcile (screen-data-map "실데이터 연결 규칙")
import { now } from '@/lib/clock';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { pickNextAlarm, toAppointment, type AppointmentRows } from './map';
import type { NextAlarm } from './types';

// 내 참여 조건 하나의 약속 · 알람 전부 · 그룹 이름 · 준비물 (H01 · H02 · H03이 같이 씀)
//   내 것이 아니거나(RLS) 없으면 null
export async function loadAppointmentRows(participantId: string, userId: string): Promise<AppointmentRows | null> {
  const { data, error } = await supabase
    .from('appointment_participants')
    .select(
      'origin_name, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes, appointments(appointment_id, title, appointment_at, dest_name, importance, recurrence_rule, groups(group_name)), alarms(alarm_id, alarm_type, scheduled_at, intensity, sound_key, is_enabled)',
    )
    .eq('participant_id', participantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const appointment = data?.appointments;
  if (!data || !appointment) return null;

  const todos = await supabase
    .from('todos')
    .select('title')
    .eq('user_id', userId)
    .eq('appointment_id', appointment.appointment_id)
    .eq('todo_type', 'ITEM')
    .order('created_at');
  if (todos.error) throw todos.error;

  return {
    appointment,
    participant: data,
    alarms: data.alarms,
    groupName: appointment.groups?.group_name ?? null,
    items: (todos.data ?? []).map((t) => t.title),
  };
}

// H01 다음 알람 — 지금 이후 가장 먼저 울릴 켜진 알람(기상 · 준비 · 출발)이 있는 약속. 일정 없는 알람 · 루틴 알람은 목업처럼 여기 안 나옴 (NextAlarm이 약속을 들고 있음)
export async function getNextAlarm(): Promise<NextAlarm | null> {
  const userId = await requireUserId();
  const at = now();
  const { data, error } = await supabase
    .from('alarms')
    .select('participant_id')
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .in('alarm_type', ['WAKE', 'PREPARE', 'DEPARTURE'])
    .not('participant_id', 'is', null)
    .gte('scheduled_at', at.toISOString())
    .order('scheduled_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.participant_id) return null;

  const rows = await loadAppointmentRows(data.participant_id, userId);
  return rows ? pickNextAlarm([toAppointment(rows)], at.getTime()) : null;
}
