// ① 약속 기반 알람 — 실데이터 쓰기 중 DB에 직접 쓰는 것 (켜기 · 끄기 · 강도). screen-data-map "쓰기 경로"
//   DB 직접(RLS 본인) → 그 알람만 폰에 맞춤(reconcile({ alarmIds })). 시각이 바뀌는 저장은 alarm-commit(realPlan.ts)
//   · 강도를 직접 고르면 intensity_source = MANUAL, 자동으로 되돌리면 AUTO — 안 쓰면 다음 alarm-commit이 직접 고른 값을 자동값으로 덮음 (서버는 MANUAL인 것만 이어받음)
//   · 시각(time_source)은 이 파일에서 안 바꿈 — 시각을 직접 고르는 길은 alarm-commit의 manual_times뿐
//   · 켤 때는 아직 안 지난 알람만 켬 — 지난 기상 알람을 켜면 서버 배치(wake-check)가 울린 적 없는 알람을 기상 미확인(MISSED)으로 기록하므로
//   · 도착 목표(ARRIVE)는 폰에서 "도착했어요" 무음 알림으로 울리므로 울리는 알람이 하나라도 켜져 있을 때만 켜 둠 (화면은 도착 목표를 늘 켜짐으로 그림)
import { reconcile } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import { isUuid } from '@/lib/uuid';
import { autoLevel, resolveIntensity } from '@shared/calc/intensity.ts';

import { forgetDetail } from './detailCache';
import { storedOverrides } from './map';
import { fetchLateCount, fetchWakeSensitivity, loadAppointmentRowsByAppointment } from './realRows';
import type { AlarmKind, IntensityAxis, Level } from './types';

const PHONE_FAILED = '폰에 알람을 반영하지 못했어요. 알람 권한을 확인하고 앱을 다시 열어 주세요';
const NOT_FOUND = '알람을 찾을 수 없어요. 이미 지워졌을 수 있어요';
const NOTHING_TO_TURN_ON = '켤 수 있는 알람이 없어요. 이미 지난 알람이거나 지워졌을 수 있어요';

// 바꾼 알람을 폰에 맞춤 — 걸거나 지우지 못한 것(정확한 알람 권한 없음 등)이 있으면 알려 줌. DB에는 이미 썼으니 사용자가 고치고 다시 하거나 앱을 다시 열면 맞춰짐
export async function syncPhone(alarmIds: readonly string[]): Promise<void> {
  if (!alarmIds.length) return;
  const summary = await reconcile({ alarmIds });
  if (summary.failed.length) throw new UserError(PHONE_FAILED);
}

async function findParticipantId(userId: string, appointmentId: string): Promise<string | null> {
  if (!isUuid(appointmentId)) return null; // 가짜 데이터 시절 주소가 남아 있어도 DB 형식 오류 대신 "없음"
  const { data, error } = await supabase.from('appointment_participants').select('participant_id').eq('appointment_id', appointmentId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.participant_id ?? null;
}

// 울리는 알람(기상 · 준비 · 출발)이 하나라도 켜져 있는지에 도착 목표를 맞춤. 바뀐 도착 목표 알람 id를 돌려줌 (없으면 빈 목록)
export async function mirrorArrive(userId: string, participantId: string): Promise<string[]> {
  const { data, error } = await supabase.from('alarms').select('alarm_id, alarm_type, is_enabled').eq('participant_id', participantId).eq('user_id', userId);
  if (error) throw error;
  const rows = data ?? [];
  const anyRing = rows.some((r) => r.alarm_type !== 'ARRIVE' && r.alarm_type !== 'ROUTINE' && r.is_enabled);
  const arrive = rows.find((r) => r.alarm_type === 'ARRIVE');
  if (!arrive || arrive.is_enabled === anyRing) return [];
  const res = await supabase.from('alarms').update({ is_enabled: anyRing }).eq('alarm_id', arrive.alarm_id).eq('user_id', userId);
  if (res.error) throw res.error;
  return [arrive.alarm_id];
}

// 일정의 알람 전체 켜기 · 끄기 (H01 · H02) — id는 약속 id, 일정 없는 알람이면 알람 id
//   끌 때는 도착 목표까지 전부. 켤 때는 아직 안 지난 울리는 알람(기상 · 준비 · 출발)만 켜고, 도착 목표는 그 결과에 맞춤(mirrorArrive) —
//   도착 목표 시각이 가장 늦어서 전체에 "안 지난 것" 조건을 걸면 울리는 알람이 다 지난 일정에서 도착 목표만 켜지고 "켰어요"로 보임
export async function setAppointmentEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isUuid(id)) throw new UserError(NOT_FOUND); // 약속 id도 알람 id도 아님 (가짜 데이터 시절 주소)
  const userId = await requireUserId();
  const participantId = await findParticipantId(userId, id);
  const base = supabase.from('alarms').update({ is_enabled: enabled }).eq('user_id', userId);
  const target = participantId ? base.eq('participant_id', participantId) : base.eq('alarm_id', id).is('participant_id', null).is('routine_id', null);
  const { data, error } = await (enabled ? target.neq('alarm_type', 'ARRIVE').gt('scheduled_at', now().toISOString()) : target).select('alarm_id');
  if (error) throw error;
  if (!data?.length) throw new UserError(enabled ? NOTHING_TO_TURN_ON : NOT_FOUND);
  const arrive = enabled && participantId ? await mirrorArrive(userId, participantId) : [];
  forgetDetail(id);
  await syncPhone([...data.map((r) => r.alarm_id), ...arrive]);
}

// 종류별 켜기 · 끄기 (H03)
//   부르는 화면 없음 — H03의 켜기 · 강도는 저장 때 alarm-commit(enabled · levels)에 실려 감 (realPlan.ts saveAlarmSettings). 가짜 모드의 saveAlarmSettings(api.ts)만 같은 이름의 api 함수를 부름
export async function setAlarmEnabled(id: string, kind: AlarmKind, enabled: boolean): Promise<void> {
  const userId = await requireUserId();
  const participantId = await findParticipantId(userId, id);
  if (!participantId) throw new UserError(NOT_FOUND);
  const target = supabase.from('alarms').update({ is_enabled: enabled }).eq('participant_id', participantId).eq('user_id', userId).eq('alarm_type', kind);
  const { data, error } = await (enabled ? target.gt('scheduled_at', now().toISOString()) : target).select('alarm_id');
  if (error) throw error;
  if (!data?.length) throw new UserError(enabled ? NOTHING_TO_TURN_ON : NOT_FOUND);
  const arrive = await mirrorArrive(userId, participantId);
  forgetDetail(id);
  await syncPhone([...data.map((r) => r.alarm_id), ...arrive]);
}

// 부르는 화면 없음 — H03의 켜기 · 강도는 alarm-commit (setAlarmEnabled 주석 참고)
// 강도 직접 고르기 — level이 null이면 그 칸만 자동으로 되돌림. 서버가 같은 규칙으로 쓰는 세 칸(진동 intensity · 말소리 voice_tone · 배경음 sound_key)을
// 약속의 모든 알람에 같은 값으로 씀 (한 일정의 강도). 다른 칸은 지금 직접 고른 값을 이어서 자동 값과 다른 칸만 MANUAL로 남김
export async function setIntensity(id: string, axis: IntensityAxis, level: Level | null): Promise<void> {
  const userId = await requireUserId();
  const rows = await loadAppointmentRowsByAppointment(id, userId);
  if (!rows) throw new UserError(NOT_FOUND);
  const [lateCount, wakeSensitivity] = await Promise.all([fetchLateCount(userId, now().getTime()), fetchWakeSensitivity(userId)]);
  const importance = rows.appointment.importance;
  const picked = { ...storedOverrides(rows.alarms, autoLevel(importance, lateCount, wakeSensitivity)), [axis]: level };
  const { fields, manual } = resolveIntensity(importance, lateCount, picked, wakeSensitivity);
  const { data, error } = await supabase
    .from('alarms')
    .update({ intensity: fields.intensity, voice_tone: fields.voiceTone, sound_key: fields.soundKey, intensity_source: manual ? 'MANUAL' : 'AUTO' })
    .eq('participant_id', rows.participant.participant_id)
    .eq('user_id', userId)
    .select('alarm_id');
  if (error) throw error;
  forgetDetail(id);
  await syncPhone((data ?? []).map((r) => r.alarm_id));
}
