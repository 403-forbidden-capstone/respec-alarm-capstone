// DB 행 → 화면 타입(types.ts) 바꾸기 — 순수 함수만 (시험: __tests__/map.test.ts). 쿼리는 real.ts
// 실데이터 구현의 틀 (P6): 쿼리는 real.ts에서 얇게, 행 → 화면 모양 변환은 여기서 순수 함수로 빼서 jest로 시험
import type { Tables } from '@/types/database';
import { levelOfIntensity, levelOfSoundKey } from '@shared/calc/intensity.ts';
import { minutesBetween } from '@shared/calc/time.ts';

import { repeatLabel, rruleToRepeat } from './repeat';
import { MANUAL_SOURCE, ORIGIN_HOME, type Appointment, type AlarmKind, type AlarmTime, type Level, type NextAlarm } from './types';

export type AlarmRow = Pick<Tables<'alarms'>, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'intensity' | 'sound_key' | 'is_enabled'>;
export type ParticipantRow = Pick<
  Tables<'appointment_participants'>,
  'origin_name' | 'transport_type' | 'est_travel_minutes' | 'travel_source' | 'prepare_minutes' | 'buffer_minutes'
>;
export type AppointmentRow = Pick<Tables<'appointments'>, 'appointment_id' | 'title' | 'appointment_at' | 'dest_name' | 'importance' | 'recurrence_rule'>;

// 한 약속(내 참여 조건)을 화면에 그리는 데 필요한 행 묶음. alarms는 이 참여 조건의 알람 전부 (꺼진 것 · 도착 목표 포함)
export type AppointmentRows = {
  appointment: AppointmentRow;
  participant: ParticipantRow;
  alarms: readonly AlarmRow[];
  groupName: string | null; // 같이 가는 그룹 (appointments.group_id → groups.group_name)
  items: readonly string[]; // 준비물 (todos ITEM)
};

// travel_source(DB) → 화면 글자. 서버가 저장하는 값은 API · MANUAL이고 CACHED는 D5가 열려 있어 저장하지 않지만 읽기는 함
const TRAVEL_SOURCE_LABEL: Record<ParticipantRow['travel_source'], string> = {
  API: '길찾기',
  CACHED: '내 실측 이동시간',
  MANUAL: MANUAL_SOURCE,
};

// 화면이 쓰는 순서 — 기상 · 준비 · 출발 · 도착 목표
const KIND_ORDER: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];

// 알람 한 줄. ROUTINE 알람은 약속에 속하지 않아 여기 오지 않음 (호출하는 쪽이 participant_id로 거름)
//   auto(직접 고른 시각이면 자동 계산값)는 DB에 값이 없어서 여기서 채우지 않음 — time_source = MANUAL인 알람은 공용 계산(@shared/calc/chain)으로 다시 구해야 함 (H02 · H03, P6-2)
export function toAlarmTime(row: AlarmRow): AlarmTime | null {
  if (row.alarm_type === 'ROUTINE') return null;
  return { id: row.alarm_id, kind: row.alarm_type, at: new Date(row.scheduled_at), enabled: row.alarm_type === 'ARRIVE' || row.is_enabled };
}

// 강도 단계 — 한 약속의 알람은 강도 세 칸이 같은 값이라 첫 알람의 배경음 칸으로 읽음 (types.ts level = 배경음 기준)
function levelOf(rows: readonly AlarmRow[]): Level {
  const first = rows[0];
  if (!first) return 1;
  return levelOfSoundKey(first.sound_key) ?? levelOfIntensity(first.intensity) ?? 1;
}

export function toAppointment(rows: AppointmentRows): Appointment {
  const { appointment, participant } = rows;
  const alarms = KIND_ORDER.flatMap((kind) =>
    rows.alarms
      .filter((row) => row.alarm_type === kind)
      .map(toAlarmTime)
      .filter((x): x is AlarmTime => x != null),
  );
  const wake = alarms.find((x) => x.kind === 'WAKE');
  const prepare = alarms.find((x) => x.kind === 'PREPARE');
  return {
    id: appointment.appointment_id,
    title: appointment.title,
    at: new Date(appointment.appointment_at),
    place: appointment.dest_name,
    origin: participant.origin_name ?? ORIGIN_HOME,
    transport: participant.transport_type,
    travelMinutes: participant.est_travel_minutes ?? 0,
    travelSource: TRAVEL_SOURCE_LABEL[participant.travel_source],
    bufferMinutes: participant.buffer_minutes,
    beforePrepMinutes: wake && prepare ? minutesBetween(wake.at, prepare.at) : 0, // 기상 뒤 준비 알람까지 — DB에 따로 저장하지 않아 두 알람의 간격으로 읽음
    prepMinutes: participant.prepare_minutes, // 실제 준비는 기록(daily_records)에서 — 지금은 약속 시점 값
    predictedPrepMinutes: participant.prepare_minutes,
    importance: appointment.importance,
    repeatLabel: repeatLabel(rruleToRepeat(appointment.recurrence_rule)),
    recurrenceRule: appointment.recurrence_rule,
    groupName: rows.groupName,
    items: [...rows.items],
    withWake: wake != null,
    enabled: alarms.some((x) => x.kind !== 'ARRIVE' && x.enabled), // 일정 전체 켜기는 DB에 따로 없음 — 울리는 알람이 하나라도 켜져 있으면 켜짐
    alarms,
    level: levelOf(rows.alarms),
  };
}

// 지금 이후 가장 먼저 울릴 알람 (H01) — 꺼진 일정 · 꺼진 종류 · 도착 목표는 뺌. 가짜 구현(api.ts getNextAlarm)과 같은 규칙
export function pickNextAlarm(appointments: readonly Appointment[], nowMs: number): NextAlarm | null {
  let best: NextAlarm | null = null;
  for (const appointment of appointments) {
    if (!appointment.enabled) continue;
    for (const alarm of appointment.alarms) {
      if (alarm.kind === 'ARRIVE' || !alarm.enabled || alarm.at.getTime() < nowMs) continue;
      if (!best || alarm.at < best.alarm.at) best = { appointment, alarm };
    }
  }
  return best;
}
