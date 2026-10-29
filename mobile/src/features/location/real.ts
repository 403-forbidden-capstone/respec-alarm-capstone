// 위치 감지 기록 — 실데이터 (Supabase). 화면은 api.ts를 거침
//   쓰기는 모두 participantTimes.ts(출발 · 도착을 쓰는 한 곳)를 거침: 지우기 clearLocationTime, 되돌리기 recordParticipantTimes(LOCATION)
//   폰의 판정 기억(transitions forgetDetection)은 부르는 쪽(감지 안내 · 홈 정정 줄)이 맞춤 — 되돌리기는 restoreDetection (PR 6이 부름)
import { clearLocationTime, hasResponseTime, isResponse, readLocationTime, recordParticipantTimes, storedSource } from '@/features/alarm/participantTimes';
import { now } from '@/lib/clock';
import { dbTimeMs, parseDbTime } from '@/lib/dbTime';
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
  type EarlierDeparture,
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
  const base = (participantId: string, time: string) => {
    const at = parseDbTime(time);
    return { participantId, at, source: 'LOCATION' as const, settled: isSettled(at, nowMs) };
  };
  return [
    ...(departed.data ?? []).flatMap((r): LocationDetection[] => (r.departed_at ? [{ ...base(r.participant_id, r.departed_at), kind: 'DEPART', isLate: null }] : [])),
    // 지각 판정이 비어 있으면(약속 시각을 못 읽음) 지각 아님 — 사용자에게 유리한 쪽
    ...(arrived.data ?? []).flatMap((r): LocationDetection[] => (r.arrived_at ? [{ ...base(r.participant_id, r.arrived_at), kind: 'ARRIVE', isLate: r.is_late === true }] : [])),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'DEPART' ? -1 : 1));
}

// 그날(한국 0시 ~ 다음 날 0시) '확인할 기록' — 출발 알람의 위치 기록(alarm_events ACKNOWLEDGED · LOCATION) 중 지금 출발보다 앞선 것, 시각순 (7.13.7)
//   더 늦은 위치 출발로 바뀐 앞 출발은 기록 줄만 남음 (participantTimes). 지금 출발 = appointment_participants.departed_at
//   지금 출발이 응답(원탭 · 직접 입력)이면 사용자가 이미 알려 준 것이라 뺌 — 새 질문은 답에 따라 결과가 바뀔 때만 (지형님 10/29 흐름 확인(#240))
//   지금 출발이 비었으면([아니에요]로 지움) 남은 위치 출발 줄이 모두 '확인할 기록'
export async function listEarlierDepartures(day: Date): Promise<EarlierDeparture[]> {
  const userId = await requireUserId();
  const from = startOfDay(day);
  const { data, error } = await supabase
    .from('alarm_events')
    .select('event_at, alarms(alarm_type, participant_id, appointment_participants(departed_at, departed_source))')
    .eq('user_id', userId)
    .eq('event_type', 'ACKNOWLEDGED')
    .eq('input_source', 'LOCATION')
    .gte('event_at', from.toISOString())
    .lt('event_at', addDays(from, 1).toISOString());
  if (error) throw error;
  return (data ?? [])
    .flatMap((row): EarlierDeparture[] => {
      const alarm = row.alarms;
      if (alarm?.alarm_type !== 'DEPARTURE' || !alarm.participant_id) return [];
      const current = alarm.appointment_participants;
      const source = storedSource(current?.departed_at ?? null, current?.departed_source ?? null);
      if (source != null && isResponse(source)) return [];
      const at = parseDbTime(row.event_at);
      if (current?.departed_at && at.getTime() >= dbTimeMs(current.departed_at)) return []; // 지금 출발 (또는 그 뒤)
      return [{ participantId: alarm.participant_id, at }];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

// 고친 값 기록 번호 — 같은 판정을 다시 지우려 해도(앞 시도가 중간에 끊김) 한 줄만 남게
const rejectEditId = (participantId: string, kind: DetectionKind, atMs: number) => stableUuid('geo-reject', participantId, kind, atMs);

async function deleteEditLog(userId: string, editId: string): Promise<void> {
  const { error } = await supabase.from('user_edit_logs').delete().eq('user_id', userId).eq('edit_id', editId);
  if (error) throw error;
}

// [아니에요] — 지금 값이 위치일 때만 지움(응답 값 · 빈 칸이면 null). 고친 값 기록 한 줄을 먼저 남기고 지움. 그 뒤는 다음 자동 감지를 기다림
//   그 사이 원탭이 덮어 못 지웠으면 기록도 지우고 null. 동시에 두 번 눌러 다른 호출이 먼저 지웠으면(값이 비었음) 그 호출이 쓰는 기록이라 둠
//     "이 호출이 만든 줄만 지움"으로 가르지 않는 까닭: 줄을 만든 호출이 늦게 지우러 가서 실패하면(다른 호출이 먼저 지움) 유효한 정정의 기록을 지우게 됨
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
//   그 사이 다른 값이 들어왔으면 출처 규칙대로(응답 값 · 같거나 늦은 위치 출발 · 위치 도착은 그대로). 고친 값 기록은 그래도 지움 — 사용자가 정정을 거둔 것이므로 (근거 없음 — 작성자 판단). 다시 썼으면 true
export async function undoReject(snapshot: RejectSnapshot): Promise<boolean> {
  const at = snapshot.at.getTime();
  const result = await recordParticipantTimes({ participantId: snapshot.participantId, ...(snapshot.kind === 'DEPART' ? { departedAt: at } : { arrivedAt: at }), source: 'LOCATION' });
  await deleteEditLog(await requireUserId(), snapshot.editId);
  const decision = snapshot.kind === 'DEPART' ? result.departed : result.arrived;
  return decision === 'new' || decision === 'override';
}
