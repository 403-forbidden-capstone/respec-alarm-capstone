// 고친 값 기록(user_edit_logs)에 남길 줄 만들기 — 순수 함수 (시험: __tests__/edits.test.ts)
// 가짜 데이터의 saveAlarmSettings · createAppointment(api.ts)가 db.editLogs에 쌓는 규칙과 같은 줄을 만듦 (같은 시나리오 대조 시험 있음).
// 실데이터는 이 줄을 따로 insert하지 않고 alarm-commit 요청의 edits로 보냄 — 저장이 성공해야 기록이 남게 (서버가 user_edit_logs에 씀)
import { parseDbTime } from '@/lib/dbTime';
import type { Tables } from '@/types/database';

import { manualTimes } from './adjust';
import {
  RING_KINDS,
  type AlarmSettingsDraft,
  type AlarmTime,
  type AppointmentDetail,
  type CommitEditScreen,
  type EditLogField,
  type Estimate,
  type IntensityAxis,
  type Level,
  type UserEditLog,
} from './types';
import { toEditPayload, type EditPayload } from './request';

// 저장(alarm-commit edits)에 실어 보내는 줄 — 서버가 받는 화면만 (H01 · NTF · H08은 앱이 user_edit_logs에 바로 남김)
export type EditLogLine = Omit<UserEditLog, 'at'> & { screen: CommitEditScreen };

// 강도 세 칸은 DB 칸 이름으로 고친 값 기록에 남김 (types.ts UserEditLog): 배경음 = sound_key, 말소리 = voice_tone, 진동 = intensity
export const LEVEL_FIELD: Record<IntensityAxis, EditLogField> = { sound: 'sound_key', voice: 'voice_tone', vibration: 'intensity' };

// 저장 뒤의 알람과, 그 알람이 나온 자동 계산값 (alarm-suggest 응답에서)
export type SettingsAfter = {
  alarms: AlarmTime[]; // 저장 뒤 알람 (직접 고른 시각이면 auto 포함)
  autoTravelMinutes: number; // 출발 위치 · 이동 수단으로 다시 계산한 자동 이동시간
  autoPrepareMinutes: number; // 직접 고른 값이 없을 때의 준비 시간
};

// H03 저장 — 바뀐 곳마다 한 줄 (가짜 saveAlarmSettings와 같은 규칙)
//   · 입력하는 값(여유 · 출발 위치 · 이동 수단 · 켜기)은 고치기 전 값이 auto, 계산하는 값(이동 · 준비 · 알람 시각 · 강도)은 자동 계산값이 auto
//   · 직접 고른 값이 새 자동값과 같아져 자동으로 돌아간 것(이동 수단을 바꿔 자동값이 따라온 경우 등)은 사용자가 되돌린 것이 아니라 기록하지 않음 — 초안의 값이 저장된 값과 다를 때만
export function settingsEdits(saved: AppointmentDetail, draft: AlarmSettingsDraft, after: SettingsAfter): EditLogLine[] {
  const lines: EditLogLine[] = [];
  const log = (field: EditLogField, autoValue: unknown, editedValue: unknown, target: { alarmId?: string; alarmType?: AlarmTime['kind'] } = {}) =>
    lines.push({ screen: 'H03', field, appointmentId: saved.id, ...target, autoValue, editedValue });

  if (draft.bufferMinutes !== saved.bufferMinutes) log('buffer_minutes', saved.bufferMinutes, draft.bufferMinutes);
  if (draft.origin !== saved.origin) log('origin', saved.origin, draft.origin);
  if (draft.transport !== saved.transport) log('transport', saved.transport, draft.transport);

  const manualTravel = draft.travelMinutes != null && draft.travelMinutes !== after.autoTravelMinutes ? draft.travelMinutes : null;
  const savedTravel = saved.edits.travelMinutes;
  if (manualTravel !== savedTravel && draft.travelMinutes !== savedTravel) log('travel_minutes', after.autoTravelMinutes, manualTravel);

  const manualPrepare = draft.prepareMinutes != null && draft.prepareMinutes !== after.autoPrepareMinutes ? draft.prepareMinutes : null;
  const savedPrepare = saved.edits.prepareMinutes;
  if (manualPrepare !== savedPrepare && draft.prepareMinutes !== savedPrepare) log('prepare_minutes', after.autoPrepareMinutes, manualPrepare);

  const pickedTimes = manualTimes(after.alarms);
  for (const kind of RING_KINDS) {
    const before = saved.edits.times[kind];
    const typed = draft.times[kind];
    const picked = pickedTimes[kind];
    if (before?.getTime() === picked?.getTime() || before?.getTime() === typed?.getTime()) continue;
    const alarm = after.alarms.find((x) => x.kind === kind);
    if (alarm) log('scheduled_at', alarm.auto ?? alarm.at, picked ?? null, { alarmId: alarm.id, alarmType: kind });
  }

  for (const alarm of saved.alarms) {
    if (alarm.kind === 'ARRIVE') continue;
    const picked = draft.kinds[alarm.kind];
    if (picked == null || picked === alarm.enabled) continue;
    log('alarm_enabled', alarm.enabled, picked, { alarmId: alarm.id, alarmType: alarm.kind });
  }

  for (const [axis, level] of Object.entries(draft.levels) as [IntensityAxis, Level | null][]) {
    const current = saved.intensity.axes[axis].manual ? saved.intensity.axes[axis].level : null;
    if (current === level) continue;
    log(LEVEL_FIELD[axis], saved.intensity.auto, level);
  }
  return lines;
}

// H05 저장 — 확인 시트에서 알람 시각을 직접 고른 것마다 한 줄 (D43)
export function createEdits(estimate: Estimate): EditLogLine[] {
  return estimate.appointment.alarms.flatMap((alarm) =>
    alarm.auto
      ? [
          {
            screen: 'H05' as const,
            field: 'scheduled_at' as const,
            appointmentId: estimate.appointment.id,
            alarmId: alarm.id,
            alarmType: alarm.kind,
            autoValue: alarm.auto,
            editedValue: alarm.at,
          },
        ]
      : [],
  );
}

// user_edit_logs 한 줄 → 화면 UserEditLog. field는 DB가 열어 둔 글자(앱 화면의 값 이름)라 모양만 맞춰 읽음, ROUTINE 알람은 종류를 비움
export function fromEditRow(row: Pick<Tables<'user_edit_logs'>, 'created_at' | 'screen' | 'field' | 'appointment_id' | 'alarm_id' | 'alarm_type' | 'auto_value' | 'edited_value'>): UserEditLog {
  return {
    at: parseDbTime(row.created_at),
    screen: row.screen as UserEditLog['screen'],
    field: row.field as EditLogField,
    ...(row.appointment_id ? { appointmentId: row.appointment_id } : {}),
    ...(row.alarm_id ? { alarmId: row.alarm_id } : {}),
    ...(row.alarm_type && row.alarm_type !== 'ROUTINE' ? { alarmType: row.alarm_type } : {}),
    autoValue: row.auto_value,
    editedValue: row.edited_value,
  };
}

// 서버로 보낼 모양 (alarm-commit의 edits). 새 일정은 서버가 알람 종류로 알람 id를 찾아 붙임
export const toEditPayloads = (lines: readonly EditLogLine[]): EditPayload[] => lines.map(toEditPayload);
