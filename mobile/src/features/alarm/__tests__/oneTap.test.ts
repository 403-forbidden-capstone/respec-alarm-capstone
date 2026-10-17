import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AlarmEvent } from '@capstone/alarm-core';

import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { followUpOneTap, oneTapOf, planOneTapUpdates } from '../oneTap';

// 값을 쓰는 규칙(출처 우선순위 · 지각 · 준비 실측)은 participantTimes.test.ts가 맡음 — 여기서는 어느 참여 조건의 어떤 시각을 넘기는지만 확인
let mockHandler: (call: FakeCall) => FakeResult | undefined = () => undefined;
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
  return { supabase: { from: (table: string) => build(table, (call) => mockHandler(call)) } };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
const mockRecord = jest.fn<(input: { participantId: string; departedAt?: number; arrivedAt?: number; source: string }) => Promise<unknown>>();
jest.mock('../participantTimes', () => ({ recordParticipantTimes: (input: Parameters<typeof mockRecord>[0]) => mockRecord(input) }));

const APPOINTMENT_AT = Date.parse('2025-05-22T10:00:00+09:00');
const min = (m: number) => APPOINTMENT_AT + m * 60_000;

const event = (id: string, alarmId: string, eventType: AlarmEvent['eventType'], alarmType: AlarmEvent['alarmType'], at: number): AlarmEvent => ({
  clientEventId: id,
  alarmId,
  alarmType,
  eventType,
  at,
  sequenceNo: 1,
  inputSource: 'BUTTON',
});

describe('어떤 기록이 원탭 뒤처리 대상인지 (oneTapOf)', () => {
  it('출발 알람의 ACKNOWLEDGED = 출발, 도착 알람의 ARRIVAL_CONFIRMED = 도착 — 준비 시작 · 루틴 "했어요"는 해당 없음', () => {
    expect(oneTapOf({ eventType: 'ACKNOWLEDGED', alarmType: 'DEPARTURE' })).toBe('DEPARTED');
    expect(oneTapOf({ eventType: 'ARRIVAL_CONFIRMED', alarmType: 'ARRIVE' })).toBe('ARRIVED');
    expect(oneTapOf({ eventType: 'ACKNOWLEDGED', alarmType: 'PREPARE' })).toBeNull();
    expect(oneTapOf({ eventType: 'ACKNOWLEDGED', alarmType: 'ROUTINE' })).toBeNull();
    expect(oneTapOf({ eventType: 'DISMISSED', alarmType: 'WAKE' })).toBeNull();
  });
});

describe('참여 조건별로 묶기 (planOneTapUpdates)', () => {
  const participantOf = new Map([
    ['dep-alarm', 'p-1'],
    ['arrive-alarm', 'p-1'],
  ]);

  it('출발 원탭 → departedAt, 도착 원탭 → arrivedAt (같은 참여 조건이면 한 묶음)', () => {
    const updates = planOneTapUpdates(
      [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(8))],
      participantOf,
    );
    expect(updates).toEqual([{ participantId: 'p-1', departedAt: min(-60), arrivedAt: min(8) }]);
  });

  it('같은 원탭이 여러 번이면 가장 이른 시각', () => {
    const [update] = planOneTapUpdates(
      [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-50)), event('e0', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-58))],
      participantOf,
    );
    expect(update.departedAt).toBe(min(-58));
  });

  it('참여 조건을 못 찾은 기록(지워진 알람 · 일정 없는 알람)과 대상이 아닌 기록은 건너뜀', () => {
    expect(planOneTapUpdates([event('e1', 'gone', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'dep-alarm', 'ACKNOWLEDGED', 'PREPARE', min(-90))], participantOf)).toEqual([]);
  });

  it('참여 조건이 다르면 따로', () => {
    const map = new Map([
      ['d1', 'p-1'],
      ['d2', 'p-2'],
    ]);
    const updates = planOneTapUpdates([event('e1', 'd1', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'd2', 'ACKNOWLEDGED', 'DEPARTURE', min(-30))], map);
    expect(updates.map((u) => u.participantId)).toEqual(['p-1', 'p-2']);
  });
});

describe('DB에 옮기기 (followUpOneTap)', () => {
  const calls: FakeCall[] = [];
  const alarmRows = [
    { alarm_id: 'dep-alarm', participant_id: 'p-1' },
    { alarm_id: 'arrive-alarm', participant_id: 'p-1' },
  ];

  beforeEach(() => {
    calls.length = 0;
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({});
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: alarmRows } : undefined;
    };
  });

  const taps = [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(8))];

  it('내 알람만 읽어 참여 조건을 찾고, 출발 · 도착을 한 함수(recordParticipantTimes, 출처 BUTTON)에 넘김', async () => {
    await followUpOneTap(taps);
    expect(calls).toHaveLength(1);
    const [read] = calls;
    expect(read).toMatchObject({ table: 'alarms', op: 'select' });
    expect(filterArgs(read, 'in', 'alarm_id')).toEqual([['dep-alarm', 'arrive-alarm']]);
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({ participantId: 'p-1', departedAt: min(-60), arrivedAt: min(8), source: 'BUTTON' });
  });

  it('원탭이 아닌 기록만 있으면 DB를 읽지 않음', async () => {
    await followUpOneTap([event('e3', 'x', 'DISMISSED', 'WAKE', min(-120)), event('e4', 'x', 'ACKNOWLEDGED', 'PREPARE', min(-90))]);
    expect(calls).toEqual([]);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('일정 없는 알람(참여 조건 없음)의 기록은 건너뜀', async () => {
    mockHandler = (call) => (call.op === 'select' ? { data: [{ alarm_id: 'dep-alarm', participant_id: null }] } : undefined);
    await followUpOneTap([taps[0]]);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('일시 오류(네트워크 등)는 던져서 기록을 폰에 남기고 다음에 다시', async () => {
    mockHandler = () => ({ error: { code: '', message: 'Network request failed' } });
    await expect(followUpOneTap(taps)).rejects.toMatchObject({ message: 'Network request failed' });
    mockHandler = (call) => (call.op === 'select' ? { data: alarmRows } : undefined);
    mockRecord.mockRejectedValue({ code: '', message: 'timeout' });
    await expect(followUpOneTap(taps)).rejects.toMatchObject({ message: 'timeout' });
  });

  it('다시 해도 소용없는 오류(권한 · 없는 행)는 삼킴 — 다른 참여 조건의 기록은 이어서 처리', async () => {
    mockHandler = () => ({ error: { code: '42501', message: 'permission denied' } });
    await expect(followUpOneTap(taps)).resolves.toBeUndefined();

    mockHandler = (call) => (call.op === 'select' ? { data: [{ alarm_id: 'd1', participant_id: 'p-1' }, { alarm_id: 'd2', participant_id: 'p-2' }] } : undefined);
    mockRecord.mockReset();
    mockRecord.mockRejectedValueOnce({ code: '42501', message: 'rls' });
    mockRecord.mockResolvedValue({});
    await expect(followUpOneTap([event('e1', 'd1', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'd2', 'ACKNOWLEDGED', 'DEPARTURE', min(-30))])).resolves.toBeUndefined();
    expect(mockRecord.mock.calls.map(([input]) => input.participantId)).toEqual(['p-1', 'p-2']);
  });
});
