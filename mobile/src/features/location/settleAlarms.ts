// 위치로 출발 · 도착이 잡히면 그 약속의 남은 알람을 폰에서 바로 정리 (G3, 11/19 세 알람)
//   · 출발이 잡히면 준비 · 출발 알람 — 이미 나섰으니 "곧 출발하세요"가 울리면 안 됨
//   · 도착이 잡히면 준비 · 출발 · 도착 알람 — 이미 도착했는데 "도착했어요?"가 울리면 안 됨
//   reconcile의 dropRecorded와 같은 규칙(DONE_BY_DEPARTURE · DONE_BY_ARRIVAL)인데, 앱을 다시 열 때를 기다리지 않고 위치 작업이 서버에 쓴 직후(앱이 꺼진 채 헤드리스 작업 포함) 지움
//   AlarmCore.cancel은 저장소 알람 · 미룬 대기 · 울리는 중 · 이미 알림창에 떠 있는 알림까지 거둠 — reconcile은 이미 울려 저장소에서 지워진 알림을 못 거둠
//   맞춘 뒤 훅(지오펜스 다시 등록)은 부르지 않음 — 위치 작업이 스스로 부른 일이라 서로 부르는 고리가 생기지 않게
import { cancelPhoneAlarms } from '@/lib/alarmSync';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import type { TimeKind } from '@/features/alarm/participantTimes';

const SETTLED_TYPES: Record<TimeKind, ReadonlySet<string>> = {
  DEPART: new Set(['PREPARE', 'DEPARTURE']),
  ARRIVE: new Set(['PREPARE', 'DEPARTURE', 'ARRIVE']),
};

// 정리할 알람 id — 그 참여 조건의 알람 중 종류가 맞는 것. 읽기 실패는 던짐 (부르는 쪽이 삼킴: 위치 기록은 이미 서버에 있고 다음 앱 열림의 맞추기가 같은 일을 함)
export async function remainingAlarmIds(participantId: string, kind: TimeKind): Promise<string[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('alarms').select('alarm_id, alarm_type').eq('participant_id', participantId).eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).filter((row) => SETTLED_TYPES[kind].has(row.alarm_type)).map((row) => row.alarm_id);
}

// 던지지 않음 — 못 지워도 위치 기록 · 다음 맞추기(앱이 앞에 올 때)는 그대로
export async function settlePhoneAlarms(participantId: string, kind: TimeKind): Promise<void> {
  try {
    const ids = await remainingAlarmIds(participantId, kind);
    if (ids.length) await cancelPhoneAlarms(ids);
  } catch (e) {
    if (__DEV__) console.warn('[location] 남은 알람 정리 실패 — 다음 맞추기에서', e instanceof Error ? e.message : e);
  }
}
