// 준비 시작 기록 (알람 조정 제안 1단계 · 안건 D111 3번) — 준비 알람을 끈 시각을 그 참여 조건의 준비 시작으로 남김
//   준비 알람(PREPARE)을 끄거나(DISMISSED) 원탭 "준비 시작"을 누르면(ACKNOWLEDGED) 폰이 울림 기록을 쌓고,
//   그 기록이 서버(alarm_events)에 올라간 뒤 이 파일이 appointment_participants.prepare_started_at · prepare_started_source(PREPARE_ALARM)를 채움 (lib/alarmSync onEventsUploaded 훅)
//   · 제안의 "실제 준비" = 출발(departed_at) − 준비 시작. 제안을 만드는 쪽(새벽 · 저녁 계산)은 다음 PR
//   · 처음 한 번만 — 이미 값이 있으면 덮지 않음 (같은 기록으로 다시 불려도 같은 결과, 먼저 끈 것이 사실)
//   · 한 참여 조건에 해제 · 원탭이 둘 다 있으면 가장 이른 시각
//   · 준비 알람을 꺼 둔 날의 대체(그날 준비 알람 예정 시각 뒤 처음 체크한 루틴 단계, 출처 ROUTINE_STEP)는 아직 없음 — 그날은 준비 시작이 비어 근거에서 빠짐
// 묶기는 순수 함수(planPrepareStarts, 시험: __tests__/prepareStart.test.ts), 아래 followUpPrepareStart가 DB를 읽고 씀 (oneTap.ts와 같은 모양)
import type { AlarmEvent } from '@capstone/alarm-core';

import { isPermanentInsertError } from '@/lib/alarmSync/events';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

// 준비 알람을 끈 기록인지 — 해제(DISMISSED) 또는 원탭 "준비 시작"(ACKNOWLEDGED)
export function isPrepareStart(event: Pick<AlarmEvent, 'eventType' | 'alarmType'>): boolean {
  return event.alarmType === 'PREPARE' && (event.eventType === 'DISMISSED' || event.eventType === 'ACKNOWLEDGED');
}

export type PrepareStartUpdate = { participantId: string; startedAt: number }; // epoch ms

// 올라간 기록 → 참여 조건별 가장 이른 준비 시작. 참여 조건을 못 찾은 기록(지워진 알람 · 일정 없는 알람)은 건너뜀
export function planPrepareStarts(events: readonly AlarmEvent[], participantOf: ReadonlyMap<string, string>): PrepareStartUpdate[] {
  const first = new Map<string, number>();
  for (const event of events) {
    const participantId = isPrepareStart(event) ? participantOf.get(event.alarmId) : undefined;
    if (!participantId) continue;
    first.set(participantId, Math.min(first.get(participantId) ?? Infinity, event.at));
  }
  return [...first].map(([participantId, startedAt]) => ({ participantId, startedAt }));
}

export async function followUpPrepareStart(events: readonly AlarmEvent[]): Promise<void> {
  const starts = events.filter(isPrepareStart);
  if (!starts.length) return;
  const userId = await requireUserId();

  const alarmIds = [...new Set(starts.map((e) => e.alarmId))];
  const { data, error } = await supabase.from('alarms').select('alarm_id, participant_id').in('alarm_id', alarmIds).eq('user_id', userId);
  if (error) {
    if (isPermanentInsertError(error)) return;
    throw error;
  }

  const participantOf = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.participant_id) participantOf.set(row.alarm_id, row.participant_id); // 일정 없는 알람은 준비 시작이 없음
  }

  for (const update of planPrepareStarts(starts, participantOf)) {
    // 비어 있을 때만 — 이미 있으면 0행(덮지 않음). 남의 참여 조건은 RLS가 0행
    const { error: writeError } = await supabase
      .from('appointment_participants')
      .update({ prepare_started_at: new Date(update.startedAt).toISOString(), prepare_started_source: 'PREPARE_ALARM' })
      .eq('participant_id', update.participantId)
      .eq('user_id', userId)
      .is('prepare_started_at', null);
    if (writeError && !isPermanentInsertError(writeError)) throw writeError;
  }
}
