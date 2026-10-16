// 폰에 쌓인 울림 기록 → alarm_events 행 — 순수 함수 (시험: __tests__/events.test.ts)
import type { AlarmEvent } from '@capstone/alarm-core';

import type { TablesInsert } from '@/types/database';

export type EventRow = TablesInsert<'alarm_events'>;

// 폰의 AlarmEvent(camelCase) → DB 행. alarmType은 DB에 칸이 없어 뺌 (종류는 alarm_id로 알 수 있음)
// clientEventId는 폰이 만든 UUID — DB의 client_event_id(유일)에 그대로 들어가 같은 기록을 두 번 올려도 한 번만 저장됨 (Q11 A)
export function toEventRow(userId: string, event: AlarmEvent): EventRow {
  return {
    user_id: userId,
    alarm_id: event.alarmId,
    client_event_id: event.clientEventId,
    event_type: event.eventType,
    event_at: new Date(event.at).toISOString(),
    sequence_no: event.sequenceNo,
    snooze_minutes: event.snoozeMinutes ?? null,
    input_source: event.inputSource,
  };
}

// 다시 올려도 소용없는 오류인지 (그 기록은 버림) — 네트워크 · 서버 일시 오류와 구분
//   42501 RLS 위반 (남의 알람 · 이미 지워진 알람), 23503 외래키 (알람 행이 없음), 22P02 UUID 모양이 아님 (예전 가짜 id), 23502/23514 칼럼 제약
// 로그아웃 뒤 다른 계정으로 들어왔을 때 앞 계정의 기록이 계속 막히는 것도 막아 줌
const PERMANENT_CODES = new Set(['42501', '23503', '22P02', '23502', '23514', '22007', '22008']);

export function isPermanentInsertError(error: { code?: string | null } | null | undefined): boolean {
  return error?.code != null && PERMANENT_CODES.has(error.code);
}
