import { describe, expect, it } from '@jest/globals';
import type { AlarmEvent } from '@capstone/alarm-core';

import { isPermanentInsertError, toEventRow } from '../events';

const event: AlarmEvent = {
  clientEventId: '0b7c9e0e-5b8a-4a30-9f0b-2c1d3e4f5a6b',
  alarmId: '3f2b1c0e-5a4d-4e8f-9b7a-1c2d3e4f5a6b',
  alarmType: 'WAKE',
  eventType: 'SNOOZED',
  at: Date.parse('2026-10-20T22:30:00.000Z'),
  snoozeMinutes: 10,
  sequenceNo: 2,
  inputSource: 'BUTTON',
};

describe('울림 기록 → alarm_events 행', () => {
  it('칸 이름을 DB에 맞추고 alarmType은 뺌', () => {
    expect(toEventRow('user-1', event)).toEqual({
      user_id: 'user-1',
      alarm_id: event.alarmId,
      client_event_id: event.clientEventId,
      event_type: 'SNOOZED',
      event_at: '2026-10-20T22:30:00.000Z',
      sequence_no: 2,
      snooze_minutes: 10,
      input_source: 'BUTTON',
    });
  });

  it('미루기가 아니면 snooze_minutes는 null', () => {
    const { snoozeMinutes: _snooze, ...rest } = event;
    expect(toEventRow('u', { ...rest, eventType: 'DISMISSED' })).toMatchObject({ event_type: 'DISMISSED', snooze_minutes: null });
  });
});

describe('다시 올려도 소용없는 오류', () => {
  it('RLS · 외래키 · UUID 모양 · 제약 위반은 버림, 네트워크 · 서버 일시 오류는 남김', () => {
    for (const code of ['42501', '23503', '22P02', '23502', '23514']) expect(isPermanentInsertError({ code })).toBe(true);
    for (const code of ['', 'PGRST301', '57014', '08006', '40001']) expect(isPermanentInsertError({ code })).toBe(false);
    expect(isPermanentInsertError(null)).toBe(false);
    expect(isPermanentInsertError({ code: null })).toBe(false);
  });
});
