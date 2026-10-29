// 위치 감지 기록 — 실데이터 (Supabase). 화면은 api.ts를 거침
//   쓰기는 모두 participantTimes.ts(출발 · 도착을 쓰는 한 곳)를 거침: 지우기 clearLocationTime, 되돌리기 recordParticipantTimes(LOCATION)
//   폰의 판정 기억(transitions forgetDetection)은 부르는 쪽(감지 안내 · 홈 정정 줄)이 맞춤
import { clearLocationTime, hasResponseTime, readLocationTime, recordParticipantTimes } from '@/features/alarm/participantTimes';
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { addDays, startOfDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import { stableUuid } from '@/lib/uuid';

import {
  DETECTION_ALARM,
  DETECTION_FIELD,
  isSettled,
  REJECTED_VALUE,
  type DetectionKind,
  type LocationDetection,
  type RejectInput,
  type RejectSnapshot,
} from './detections';

// 그날(한국 0시 ~ 다음 날 0시) 내 위치 출발 · 도착 — 출처 칸이 LOCATION인 것만, 시각순
export async function listDetections(day: Date): Promise<LocationDetection[]> {
  const userId = await requireUserId();
  const from = startOfDay(day).toISOString();
  const to = addDays(startOfDay(day), 1).toISOString();
  const [departed, arrived] = await Promise.all([
    supabase.from('appointment_participants').select('participant_id, departed_at').eq('user_id', userId).eq('departed_source', 'LOCATION').gte('departed_at', from).lt('departed_at', to),
    supabase
      .from('appointment_participants')
      .select('participant_id, arrived_at, is_late')
      .eq('user_id', userId)
      .eq('arrived_source', 'LOCATION')
      .gte('arrived_at', from)
      .lt('arrived_at', to),
  ]);
  if (departed.error) throw departed.error;
  if (arrived.error) throw arrived.error;
  const nowMs = now().getTime();
  const line = (participantId: string, kind: DetectionKind, time: string, isLate: boolean | null): LocationDetection => {
    const at = parseDbTime(time);
    return { participantId, kind, at, source: 'LOCATION', settled: isSettled(at, nowMs), isLate };
  };
  return [
    ...(departed.data ?? []).flatMap((r) => (r.departed_at ? [line(r.participant_id, 'DEPART', r.departed_at, null)] : [])),
    ...(arrived.data ?? []).flatMap((r) => (r.arrived_at ? [line(r.participant_id, 'ARRIVE', r.arrived_at, r.is_late)] : [])),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'DEPART' ? -1 : 1));
}

// 고친 값 기록 번호 — 같은 판정을 다시 지우려 해도(앞 시도가 중간에 끊김) 한 줄만 남게
const rejectEditId = (participantId: string, kind: DetectionKind, atMs: number) => stableUuid('geo-reject', participantId, kind, atMs);

async function deleteEditLog(userId: string, editId: string): Promise<void> {
  const { error } = await supabase.from('user_edit_logs').delete().eq('user_id', userId).eq('edit_id', editId);
  if (error) throw error;
}

// [아니에요] — 지금 값이 위치일 때만 지움(응답 값 · 빈 칸이면 null). 고친 값 기록 한 줄을 먼저 남기고 지움
//   그 사이 원탭이 덮어 못 지웠으면 기록도 지우고 null. 동시에 두 번 눌러 다른 호출이 먼저 지웠으면(값이 비었음) 그 호출이 쓰는 기록이라 둠
export async function rejectDetection(input: RejectInput): Promise<RejectSnapshot | null> {
  const found = await readLocationTime(input.participantId, input.kind);
  if (!found) return null;
  const userId = await requireUserId();
  const editId = rejectEditId(found.participantId, found.kind, found.at);
  const logged = await supabase.from('user_edit_logs').insert({
    edit_id: editId,
    user_id: userId,
    appointment_id: found.appointmentId,
    alarm_id: found.alarmId,
    screen: input.screen,
    field: DETECTION_FIELD[found.kind],
    alarm_type: DETECTION_ALARM[found.kind],
    auto_value: new Date(found.at).toISOString(),
    edited_value: REJECTED_VALUE,
  });
  // 23505 = 앞 시도(또는 동시에 누른 다른 호출)가 이미 남긴 같은 줄
  if (logged.error && logged.error.code !== '23505') throw logged.error;
  if (!(await clearLocationTime(found))) {
    // 못 지운 까닭이 "원탭이 덮음"일 때만 기록을 지움 — 누가 줄을 만들었든 상관없이 지금 값으로 가름 (먼저 지운 호출의 정정은 유효하므로 그 기록은 둠)
    if (await hasResponseTime(found.participantId, found.kind)) await deleteEditLog(userId, editId);
    return null;
  }
  return { participantId: found.participantId, kind: found.kind, at: new Date(found.at), editId };
}

// 5초 되돌리기 (L6 안건후보: 감지 안내 정정 · 채널 기본안) — 지운 값을 위치 출처로 다시 씀(지각 · 이동시간 · 준비 실측 · 위치 기록도 같은 규칙으로 다시 셈)
//   그 사이 다른 값이 들어왔으면 덮지 않음(위치는 빈 칸에만 씀). 고친 값 기록은 그래도 지움 — 사용자가 정정을 거둔 것이므로 (근거 없음 — 작성자 판단). 다시 썼으면 true
export async function undoReject(snapshot: RejectSnapshot): Promise<boolean> {
  const at = snapshot.at.getTime();
  const result = await recordParticipantTimes({ participantId: snapshot.participantId, ...(snapshot.kind === 'DEPART' ? { departedAt: at } : { arrivedAt: at }), source: 'LOCATION' });
  await deleteEditLog(await requireUserId(), snapshot.editId);
  return (snapshot.kind === 'DEPART' ? result.departed : result.arrived) === 'new';
}

// 도착 전 귀가로 출발 지우기 (L6 안건후보: 집 이탈 약속 붙이기 기본안, transitions RETRACT_DEPART) — 사용자 정정이 아니라 고친 값 기록 없음
//   저장된 출발이 그 시각 그대로이고 출처가 위치일 때만. 지웠으면 true
export async function retractDeparture(input: { participantId: string; at: Date | number }): Promise<boolean> {
  const atMs = typeof input.at === 'number' ? input.at : input.at.getTime();
  const found = await readLocationTime(input.participantId, 'DEPART');
  if (!found || found.at !== atMs) return false;
  return clearLocationTime(found);
}
