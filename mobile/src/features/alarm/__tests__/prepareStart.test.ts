import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AlarmEvent } from '@capstone/alarm-core';

import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { followUpPrepareStart, isPrepareStart, planPrepareStarts } from '../prepareStart';

// 준비 시작 기록 (안건 D111 3번) — 준비 알람을 끈 시각을 참여 조건의 준비 시작으로 (oneTap.test.ts와 같은 모양)
let mockHandler: (call: FakeCall) => FakeResult | undefined = () => undefined;
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
  return { supabase: { from: (table: string) => build(table, (call) => mockHandler(call)) } };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));

const PREPARE_AT = Date.parse('2025-05-22T08:30:00+09:00');
const min = (m: number) => PREPARE_AT + m * 60_000;

const event = (id: string, alarmId: string, eventType: AlarmEvent['eventType'], alarmType: AlarmEvent['alarmType'], at: number): AlarmEvent => ({
  clientEventId: id,
  alarmId,
  alarmType,
  eventType,
  at,
  sequenceNo: 1,
  inputSource: 'BUTTON',
});

describe('어떤 기록이 준비 시작인지 (isPrepareStart)', () => {
  it('준비 알람의 해제 · 원탭 "준비 시작"만 — 기상 해제 · 출발 원탭 · 루틴 "했어요" · 울림 · 미루기는 아님', () => {
    expect(isPrepareStart({ eventType: 'DISMISSED', alarmType: 'PREPARE' })).toBe(true);
    expect(isPrepareStart({ eventType: 'ACKNOWLEDGED', alarmType: 'PREPARE' })).toBe(true);
    expect(isPrepareStart({ eventType: 'DISMISSED', alarmType: 'WAKE' })).toBe(false);
    expect(isPrepareStart({ eventType: 'ACKNOWLEDGED', alarmType: 'DEPARTURE' })).toBe(false);
    expect(isPrepareStart({ eventType: 'ACKNOWLEDGED', alarmType: 'ROUTINE' })).toBe(false);
    expect(isPrepareStart({ eventType: 'TRIGGERED', alarmType: 'PREPARE' })).toBe(false);
    expect(isPrepareStart({ eventType: 'SNOOZED', alarmType: 'PREPARE' })).toBe(false);
  });
});

describe('참여 조건별로 묶기 (planPrepareStarts)', () => {
  const participantOf = new Map([
    ['prep-1', 'p-1'],
    ['prep-2', 'p-2'],
  ]);

  it('한 참여 조건에 해제 · 원탭이 둘 다 있으면 가장 이른 시각', () => {
    const plan = planPrepareStarts(
      [event('e1', 'prep-1', 'DISMISSED', 'PREPARE', min(2)), event('e2', 'prep-1', 'ACKNOWLEDGED', 'PREPARE', min(0)), event('e3', 'prep-2', 'DISMISSED', 'PREPARE', min(5))],
      participantOf,
    );
    expect(plan).toEqual([
      { participantId: 'p-1', startedAt: min(0) },
      { participantId: 'p-2', startedAt: min(5) },
    ]);
  });

  it('참여 조건을 못 찾은 기록(지워진 알람 · 일정 없는 알람)과 준비 시작이 아닌 기록은 건너뜀', () => {
    expect(planPrepareStarts([event('e1', 'gone', 'DISMISSED', 'PREPARE', min(0)), event('e2', 'prep-1', 'DISMISSED', 'WAKE', min(-30))], participantOf)).toEqual([]);
  });
});

describe('DB에 쓰기 (followUpPrepareStart)', () => {
  const calls: FakeCall[] = [];
  beforeEach(() => {
    calls.length = 0;
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: [{ alarm_id: 'prep-1', participant_id: 'p-1' }] } : undefined;
    };
  });

  it('내 알람만 읽어 참여 조건을 찾고, 비어 있을 때만 준비 시작 · 출처 PREPARE_ALARM을 씀', async () => {
    await followUpPrepareStart([event('e1', 'prep-1', 'DISMISSED', 'PREPARE', min(1))]);
    expect(calls).toHaveLength(2);
    const [read, write] = calls;
    expect(read).toMatchObject({ table: 'alarms', op: 'select' });
    expect(filterArgs(read, 'in', 'alarm_id')).toEqual([['prep-1']]);
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(write).toMatchObject({ table: 'appointment_participants', op: 'update' });
    expect(write.payload).toEqual({ prepare_started_at: new Date(min(1)).toISOString(), prepare_started_source: 'PREPARE_ALARM' });
    expect(filterArgs(write, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(filterArgs(write, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(write, 'is', 'prepare_started_at')).toEqual([null]);
  });

  it('준비 시작이 아닌 기록만 있으면 DB를 읽지 않음', async () => {
    await followUpPrepareStart([event('e1', 'x', 'DISMISSED', 'WAKE', min(-30)), event('e2', 'x', 'ACKNOWLEDGED', 'DEPARTURE', min(30))]);
    expect(calls).toEqual([]);
  });

  it('일정 없는 알람(참여 조건 없음)이면 쓰지 않음', async () => {
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: [{ alarm_id: 'prep-1', participant_id: null }] } : undefined;
    };
    await followUpPrepareStart([event('e1', 'prep-1', 'DISMISSED', 'PREPARE', min(0))]);
    expect(calls.filter((c) => c.op === 'update')).toEqual([]);
  });

  it('일시 오류는 던져서 기록을 폰에 남기고, 다시 해도 소용없는 오류(권한 · 없는 행)는 삼킴', async () => {
    mockHandler = () => ({ error: { code: '', message: 'Network request failed' } });
    await expect(followUpPrepareStart([event('e1', 'prep-1', 'DISMISSED', 'PREPARE', min(0))])).rejects.toMatchObject({ message: 'Network request failed' });
    mockHandler = (call) => (call.op === 'select' ? { data: [{ alarm_id: 'prep-1', participant_id: 'p-1' }] } : { error: { code: '42501', message: 'permission denied' } });
    await expect(followUpPrepareStart([event('e1', 'prep-1', 'DISMISSED', 'PREPARE', min(0))])).resolves.toBeUndefined();
  });
});
