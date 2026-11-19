// 원탭 뒤처리 (D58 · #41) — 출발 확인(ACKNOWLEDGED DEPARTURE)이나 알림의 "도착했어요"(ARRIVAL_CONFIRMED ARRIVE)를 폰이 울림 기록으로 쌓고,
//   11/19부터 출발은 알람이라 그 출발 확인은 "출발 알람 해제 + 위치로 출발을 판단하지 않는 약속"일 때 네이티브가 DISMISSED와 함께 남김 (예전 APK의 "출발했어요" 원탭도 같은 기록).
//   위치로 출발을 판단하는 약속(감지 켜짐)은 출발 알람 해제가 DISMISSED만 남겨 출발이 아님 — 실제 출발은 집 이탈 감지 시각(지오펜스)
//   서버(alarm-events-device)도 같은 기록에서 departed_at을 빈 칸에 채움 — 앱이 같은 값을 보내도 keep이고, 지각 · 준비 실측 · 이동시간은 여기서 이어서 셈
// 그 기록이 서버(alarm_events)에 올라간 뒤 이 파일이 출발 · 도착 시각을 participantTimes.ts의 recordParticipantTimes(source BUTTON)에 넘김 (lib/alarmSync onEventsUploaded 훅)
//   · 어느 참여 조건의 기록인지 찾아 묶는 일까지만 함. 값을 쓰는 규칙(출처 우선순위 · 지각 판정 · 준비 실측)은 위치(지오펜스)도 같이 쓰는 recordParticipantTimes에 있음
//   · 같은 원탭이 여러 번이면 가장 이른 시각 (먼저 누른 것이 사실)
//   · 같은 기록으로 다시 불려도 같은 결과 — 이미 값이 있으면 덮지 않음 (recordParticipantTimes)
// 묶기는 순수 함수(planOneTapUpdates, 시험: __tests__/oneTap.test.ts), 아래 followUpOneTap이 DB를 읽고 부름
import type { AlarmEvent } from '@capstone/alarm-core';

import { isPermanentInsertError } from '@/lib/alarmSync/events';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { recordParticipantTimes } from './participantTimes';

export type OneTap = 'DEPARTED' | 'ARRIVED';

// 이 기록이 출발 · 도착 체크인지 (준비 시작 · 루틴 "했어요"의 ACKNOWLEDGED는 해당 없음). 출발 알람의 해제(DISMISSED)만으로는 출발이 아님 — 출발 확인(ACKNOWLEDGED)이 있어야 함
export function oneTapOf(event: Pick<AlarmEvent, 'eventType' | 'alarmType'>): OneTap | null {
  if (event.eventType === 'ACKNOWLEDGED' && event.alarmType === 'DEPARTURE') return 'DEPARTED';
  if (event.eventType === 'ARRIVAL_CONFIRMED' && event.alarmType === 'ARRIVE') return 'ARRIVED';
  return null;
}

export type OneTapUpdate = {
  participantId: string;
  departedAt?: number; // epoch ms
  arrivedAt?: number;
};

// 올라간 기록 → 참여 조건별로 묶은 출발 · 도착 시각. alarmId → 참여 조건(participantOf)을 못 찾은 기록(지워진 알람 · 일정 없는 알람)은 건너뜀
//   한 참여 조건에 같은 원탭이 여러 번 있으면 가장 이른 시각
export function planOneTapUpdates(events: readonly AlarmEvent[], participantOf: ReadonlyMap<string, string>): OneTapUpdate[] {
  const first = new Map<string, OneTapUpdate>();
  for (const event of events) {
    const tap = oneTapOf(event);
    const participantId = tap ? participantOf.get(event.alarmId) : undefined;
    if (!tap || !participantId) continue;
    const entry = first.get(participantId) ?? { participantId };
    const key = tap === 'DEPARTED' ? 'departedAt' : 'arrivedAt';
    entry[key] = Math.min(entry[key] ?? Infinity, event.at);
    first.set(participantId, entry);
  }
  return [...first.values()];
}

// 올라간 기록 중 출발 · 도착 원탭을 appointment_participants에 옮김 — onEventsUploaded 훅으로 등록 (hooks/useOneTapFollowUp)
//   일시 오류(네트워크 등)는 던져서 기록을 폰에 남기고 다음 올리기 때 다시 부르게 함. 다시 해도 소용없는 오류(권한 · 없는 행)는 삼킴
export async function followUpOneTap(events: readonly AlarmEvent[]): Promise<void> {
  const taps = events.filter((e) => oneTapOf(e) != null);
  if (!taps.length) return;
  const userId = await requireUserId();

  const alarmIds = [...new Set(taps.map((e) => e.alarmId))];
  const { data, error } = await supabase.from('alarms').select('alarm_id, participant_id').in('alarm_id', alarmIds).eq('user_id', userId);
  if (error) {
    if (isPermanentInsertError(error)) return;
    throw error;
  }

  const participantOf = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.participant_id) participantOf.set(row.alarm_id, row.participant_id); // 일정 없는 알람 · 루틴은 출발 · 도착이 없음
  }

  for (const update of planOneTapUpdates(taps, participantOf)) {
    try {
      // 폰 안 버튼은 늘 BUTTON (AlarmEvent.inputSource)
      await recordParticipantTimes({ participantId: update.participantId, departedAt: update.departedAt, arrivedAt: update.arrivedAt, source: 'BUTTON' });
    } catch (e) {
      if (!isPermanentInsertError(e as { code?: string | null })) throw e;
    }
  }
}
