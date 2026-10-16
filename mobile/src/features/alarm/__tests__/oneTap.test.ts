import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AlarmEvent } from '@capstone/alarm-core';

import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { followUpOneTap, judgeArrival, LATE_AFTER_MINUTES, oneTapOf, planOneTapUpdates, type ParticipantSnapshot } from '../oneTap';

let mockHandler: (call: FakeCall) => FakeResult | undefined = () => undefined;
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
  return { supabase: { from: (table: string) => build(table, (call) => mockHandler(call)) } };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));

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

describe('지각 판정 (judgeArrival, D58 · #41)', () => {
  it('약속 시각 + 5분을 넘으면 지각, 정확히 5분은 아님', () => {
    expect(LATE_AFTER_MINUTES).toBe(5);
    expect(judgeArrival(min(5), APPOINTMENT_AT)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(judgeArrival(min(5) + 1000, APPOINTMENT_AT)).toEqual({ isLate: true, lateMinutes: 5 });
    expect(judgeArrival(min(12), APPOINTMENT_AT)).toEqual({ isLate: true, lateMinutes: 12 });
  });

  it('−2~+5분(원탭으로 확인하는 구간)과 일찍 도착은 지각이 아님', () => {
    expect(judgeArrival(min(-2), APPOINTMENT_AT)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(judgeArrival(min(3), APPOINTMENT_AT)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(judgeArrival(min(-30), APPOINTMENT_AT)).toEqual({ isLate: false, lateMinutes: 0 });
  });
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

describe('채울 값 정하기 (planOneTapUpdates)', () => {
  const snapshot = (overrides: Partial<ParticipantSnapshot> = {}): ParticipantSnapshot => ({
    participantId: 'p-1',
    appointmentAt: new Date(APPOINTMENT_AT).toISOString(),
    departedAt: null,
    arrivedAt: null,
    ...overrides,
  });
  const snapshotOf = (s = snapshot()) =>
    new Map([
      ['dep-alarm', s],
      ['arrive-alarm', s],
    ]);

  it('출발 원탭 → departed_at, 도착 원탭 → arrived_at + 지각', () => {
    const updates = planOneTapUpdates(
      [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(8))],
      snapshotOf(),
    );
    expect(updates).toEqual([
      { participantId: 'p-1', departedAt: new Date(min(-60)).toISOString(), arrival: { arrivedAt: new Date(min(8)).toISOString(), isLate: true, lateMinutes: 8 } },
    ]);
  });

  it('제시간 도착은 is_late false · late_minutes 0', () => {
    const [update] = planOneTapUpdates([event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(-3))], snapshotOf());
    expect(update.arrival).toEqual({ arrivedAt: new Date(min(-3)).toISOString(), isLate: false, lateMinutes: 0 });
  });

  it('이미 값이 있으면 덮지 않음 — 같은 기록으로 다시 불려도 같은 결과', () => {
    const done = snapshotOf(snapshot({ departedAt: new Date(min(-61)).toISOString(), arrivedAt: new Date(min(7)).toISOString() }));
    const events = [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(8))];
    expect(planOneTapUpdates(events, done)).toEqual([]);
    const first = planOneTapUpdates(events, snapshotOf());
    expect(planOneTapUpdates(events, snapshotOf())).toEqual(first);
  });

  it('같은 원탭이 여러 번이면 가장 이른 시각', () => {
    const [update] = planOneTapUpdates(
      [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-50)), event('e0', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-58))],
      snapshotOf(),
    );
    expect(update.departedAt).toBe(new Date(min(-58)).toISOString());
  });

  it('참여 조건을 못 찾은 기록(지워진 알람 · 일정 없는 알람)과 대상이 아닌 기록은 건너뜀', () => {
    expect(planOneTapUpdates([event('e1', 'gone', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'dep-alarm', 'ACKNOWLEDGED', 'PREPARE', min(-90))], snapshotOf())).toEqual([]);
  });

  it('참여 조건이 다르면 따로', () => {
    const map = new Map([
      ['d1', snapshot({ participantId: 'p-1' })],
      ['d2', snapshot({ participantId: 'p-2' })],
    ]);
    const updates = planOneTapUpdates([event('e1', 'd1', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'd2', 'ACKNOWLEDGED', 'DEPARTURE', min(-30))], map);
    expect(updates.map((u) => u.participantId)).toEqual(['p-1', 'p-2']);
  });
});

describe('DB에 옮기기 (followUpOneTap)', () => {
  const calls: FakeCall[] = [];
  const alarmRows = [
    { alarm_id: 'dep-alarm', participant_id: 'p-1', appointment_participants: { participant_id: 'p-1', departed_at: null, arrived_at: null, appointments: { appointment_at: new Date(APPOINTMENT_AT).toISOString() } } },
    { alarm_id: 'arrive-alarm', participant_id: 'p-1', appointment_participants: { participant_id: 'p-1', departed_at: null, arrived_at: null, appointments: { appointment_at: new Date(APPOINTMENT_AT).toISOString() } } },
  ];

  beforeEach(() => {
    calls.length = 0;
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: alarmRows } : undefined;
    };
  });

  const taps = [event('e1', 'dep-alarm', 'ACKNOWLEDGED', 'DEPARTURE', min(-60)), event('e2', 'arrive-alarm', 'ARRIVAL_CONFIRMED', 'ARRIVE', min(8))];

  it('내 알람만 읽고 참여 조건에 출발 · 도착을 씀 — 값이 비어 있을 때만(is null)', async () => {
    await followUpOneTap(taps);
    const [read, departure, arrival] = calls;
    expect(read).toMatchObject({ table: 'alarms', op: 'select' });
    expect(filterArgs(read, 'in', 'alarm_id')).toEqual([['dep-alarm', 'arrive-alarm']]);
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);

    expect(departure).toMatchObject({ table: 'appointment_participants', op: 'update', payload: { departed_at: new Date(min(-60)).toISOString() } });
    expect(filterArgs(departure, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(filterArgs(departure, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(departure, 'is', 'departed_at')).toEqual([null]);

    expect(arrival).toMatchObject({ op: 'update', payload: { arrived_at: new Date(min(8)).toISOString(), is_late: true, late_minutes: 8 } });
    expect(filterArgs(arrival, 'is', 'arrived_at')).toEqual([null]);
  });

  it('원탭이 아닌 기록만 있으면 DB를 읽지 않음', async () => {
    await followUpOneTap([event('e3', 'x', 'DISMISSED', 'WAKE', min(-120)), event('e4', 'x', 'ACKNOWLEDGED', 'PREPARE', min(-90))]);
    expect(calls).toEqual([]);
  });

  it('이미 값이 있는 참여 조건에는 쓰지 않음 (같은 기록으로 다시 불려도 같은 결과)', async () => {
    const filled = alarmRows.map((r) => ({
      ...r,
      appointment_participants: { ...r.appointment_participants, departed_at: new Date(min(-61)).toISOString(), arrived_at: new Date(min(7)).toISOString() },
    }));
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: filled } : undefined;
    };
    await followUpOneTap(taps);
    expect(calls.map((c) => c.op)).toEqual(['select']);
  });

  it('일시 오류(네트워크 등)는 던져서 기록을 폰에 남기고 다음에 다시', async () => {
    mockHandler = () => ({ error: { code: '', message: 'Network request failed' } });
    await expect(followUpOneTap(taps)).rejects.toMatchObject({ message: 'Network request failed' });
  });

  it('다시 해도 소용없는 오류(권한 · 없는 행)는 삼킴', async () => {
    mockHandler = () => ({ error: { code: '42501', message: 'permission denied' } });
    await expect(followUpOneTap(taps)).resolves.toBeUndefined();
    mockHandler = (call) => (call.op === 'select' ? { data: alarmRows } : { error: { code: '42501', message: 'rls' } });
    await expect(followUpOneTap(taps)).resolves.toBeUndefined();
  });

  it('쓰다가 일시 오류가 나면 던짐', async () => {
    mockHandler = (call) => (call.op === 'select' ? { data: alarmRows } : { error: { code: '', message: 'timeout' } });
    await expect(followUpOneTap(taps)).rejects.toMatchObject({ message: 'timeout' });
  });

  it('일정 없는 알람(참여 조건 없음)의 기록은 건너뜀', async () => {
    mockHandler = (call) => (call.op === 'select' ? { data: [{ alarm_id: 'dep-alarm', participant_id: null, appointment_participants: null }] } : undefined);
    await followUpOneTap([taps[0]]);
    expect(calls).toEqual([]);
  });
});
