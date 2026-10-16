// 원탭 뒤처리 (D58 · #41) — 무음 알림의 "출발했어요" · "도착했어요"를 누르면 폰이 울림 기록(ACKNOWLEDGED DEPARTURE · ARRIVAL_CONFIRMED ARRIVE)을 쌓고,
// 그 기록이 서버(alarm_events)에 올라간 뒤 이 파일이 appointment_participants의 출발 · 도착 시각과 지각을 채움 (lib/alarmSync onEventsUploaded 훅)
//   · departed_at ← 출발 원탭 시각, arrived_at ← 도착 원탭 시각, is_late · late_minutes ← 도착 시각과 약속 시각
//   · 지각: 약속 시각 + 5분을 넘으면 지각 (−2~+5분은 위치로 잡았을 때 원탭으로 확인하는 구간이고, 위치를 끈 사용자는 원탭 시각이 곧 도착 — 지금은 위치가 없어 원탭이 유일한 입력)
//   · 같은 기록으로 다시 불려도 같은 결과: 이미 값이 있으면 덮지 않음 (update ... where departed_at is null)
// 판정은 순수 함수(judgeArrival · planOneTapUpdates, 시험: __tests__/oneTap.test.ts), 아래 followUpOneTap이 DB를 읽고 씀
import type { AlarmEvent } from '@capstone/alarm-core';

import { isPermanentInsertError } from '@/lib/alarmSync/events';
import { dbTimeMs } from '@/lib/dbTime';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

// 약속 시각보다 이만큼(분)을 넘어서 도착하면 지각 — F2 · #41 (8절 "+5분 넘으면 지각")
export const LATE_AFTER_MINUTES = 5;

export function judgeArrival(arrivedAtMs: number, appointmentAtMs: number): { isLate: boolean; lateMinutes: number } {
  const diffMinutes = (arrivedAtMs - appointmentAtMs) / 60_000;
  const isLate = diffMinutes > LATE_AFTER_MINUTES;
  return { isLate, lateMinutes: isLate ? Math.round(diffMinutes) : 0 };
}

export type OneTap = 'DEPARTED' | 'ARRIVED';

// 이 기록이 출발 · 도착 원탭인지 (준비 시작 · 루틴 "했어요"의 ACKNOWLEDGED는 해당 없음)
export function oneTapOf(event: Pick<AlarmEvent, 'eventType' | 'alarmType'>): OneTap | null {
  if (event.eventType === 'ACKNOWLEDGED' && event.alarmType === 'DEPARTURE') return 'DEPARTED';
  if (event.eventType === 'ARRIVAL_CONFIRMED' && event.alarmType === 'ARRIVE') return 'ARRIVED';
  return null;
}

// 알람 하나가 가리키는 참여 조건의 지금 값 (DB에서 읽음)
export type ParticipantSnapshot = {
  participantId: string;
  appointmentAt: string; // appointments.appointment_at
  departedAt: string | null;
  arrivedAt: string | null;
};

export type OneTapUpdate = {
  participantId: string;
  departedAt?: string; // ISO
  arrival?: { arrivedAt: string; isLate: boolean; lateMinutes: number };
};

// 올라간 기록 → 채울 값. alarmId → 참여 조건(snapshot)을 못 찾은 기록(지워진 알람 · 일정 없는 알람)은 건너뜀
//   한 참여 조건에 같은 원탭이 여러 번 있으면 가장 이른 시각 (먼저 누른 것이 사실)
export function planOneTapUpdates(events: readonly AlarmEvent[], snapshotOf: ReadonlyMap<string, ParticipantSnapshot>): OneTapUpdate[] {
  const first = new Map<string, { departed?: number; arrived?: number }>();
  for (const event of events) {
    const tap = oneTapOf(event);
    const snapshot = tap ? snapshotOf.get(event.alarmId) : undefined;
    if (!tap || !snapshot) continue;
    const entry = first.get(snapshot.participantId) ?? {};
    const key = tap === 'DEPARTED' ? 'departed' : 'arrived';
    entry[key] = Math.min(entry[key] ?? Infinity, event.at);
    first.set(snapshot.participantId, entry);
  }

  const snapshots = new Map<string, ParticipantSnapshot>();
  for (const s of snapshotOf.values()) snapshots.set(s.participantId, s);

  const updates: OneTapUpdate[] = [];
  for (const [participantId, taps] of first) {
    const snapshot = snapshots.get(participantId);
    if (!snapshot) continue;
    const update: OneTapUpdate = { participantId };
    if (taps.departed != null && snapshot.departedAt == null) update.departedAt = new Date(taps.departed).toISOString();
    if (taps.arrived != null && snapshot.arrivedAt == null) {
      update.arrival = { arrivedAt: new Date(taps.arrived).toISOString(), ...judgeArrival(taps.arrived, dbTimeMs(snapshot.appointmentAt)) };
    }
    if (update.departedAt || update.arrival) updates.push(update);
  }
  return updates;
}

// 올라간 기록 중 출발 · 도착 원탭을 appointment_participants에 옮김 — onEventsUploaded 훅으로 등록 (hooks/useOneTapFollowUp)
//   일시 오류(네트워크 등)는 던져서 기록을 폰에 남기고 다음 올리기 때 다시 부르게 함. 다시 해도 소용없는 오류(권한 · 없는 행)는 삼킴
export async function followUpOneTap(events: readonly AlarmEvent[]): Promise<void> {
  const taps = events.filter((e) => oneTapOf(e) != null);
  if (!taps.length) return;
  const userId = await requireUserId();

  const alarmIds = [...new Set(taps.map((e) => e.alarmId))];
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, participant_id, appointment_participants(participant_id, departed_at, arrived_at, appointments(appointment_at))')
    .in('alarm_id', alarmIds)
    .eq('user_id', userId);
  if (error) {
    if (isPermanentInsertError(error)) return;
    throw error;
  }

  const snapshotOf = new Map<string, ParticipantSnapshot>();
  for (const row of data ?? []) {
    const participant = row.appointment_participants;
    const appointment = participant?.appointments;
    if (!participant || !appointment) continue; // 일정 없는 알람 · 루틴은 출발 · 도착이 없음
    snapshotOf.set(row.alarm_id, {
      participantId: participant.participant_id,
      appointmentAt: appointment.appointment_at,
      departedAt: participant.departed_at,
      arrivedAt: participant.arrived_at,
    });
  }

  for (const update of planOneTapUpdates(taps, snapshotOf)) {
    if (update.departedAt) {
      const res = await supabase
        .from('appointment_participants')
        .update({ departed_at: update.departedAt })
        .eq('participant_id', update.participantId)
        .eq('user_id', userId)
        .is('departed_at', null);
      if (res.error && !isPermanentInsertError(res.error)) throw res.error;
    }
    if (update.arrival) {
      const { arrivedAt, isLate, lateMinutes } = update.arrival;
      const res = await supabase
        .from('appointment_participants')
        .update({ arrived_at: arrivedAt, is_late: isLate, late_minutes: lateMinutes })
        .eq('participant_id', update.participantId)
        .eq('user_id', userId)
        .is('arrived_at', null);
      if (res.error && !isPermanentInsertError(res.error)) throw res.error;
    }
  }
}
