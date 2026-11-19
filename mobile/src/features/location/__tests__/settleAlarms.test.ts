import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { filterArgs, type FakeCall, type FakeResult } from '../../alarm/testkit/fakeSupabase';
import { remainingAlarmIds, settlePhoneAlarms } from '../settleAlarms';

// 위치로 출발 · 도착이 잡힌 약속의 남은 알람을 폰에서 정리 (G3) — 어떤 종류를 지우는지, 실패를 삼키는지
let mockHandler: (call: FakeCall) => FakeResult | undefined = () => undefined;
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('../../alarm/testkit/fakeSupabase')>('../../alarm/testkit/fakeSupabase');
  return { supabase: { from: (table: string) => build(table, (call) => mockHandler(call)) } };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
const mockCancel = jest.fn<(ids: readonly string[]) => Promise<unknown>>();
jest.mock('@/lib/alarmSync', () => ({ cancelPhoneAlarms: (ids: readonly string[]) => mockCancel(ids) }));

const rows = [
  { alarm_id: 'wake', alarm_type: 'WAKE' },
  { alarm_id: 'prep', alarm_type: 'PREPARE' },
  { alarm_id: 'dep', alarm_type: 'DEPARTURE' },
  { alarm_id: 'arr', alarm_type: 'ARRIVE' },
];

describe('남은 알람 정리 (settlePhoneAlarms)', () => {
  const calls: FakeCall[] = [];
  beforeEach(() => {
    calls.length = 0;
    mockCancel.mockReset();
    mockCancel.mockResolvedValue({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockHandler = (call) => {
      calls.push(call);
      return call.op === 'select' ? { data: rows } : undefined;
    };
  });

  it('출발이 잡히면 준비 · 출발 알람만 — 기상 · 도착은 그대로', async () => {
    await settlePhoneAlarms('p-1', 'DEPART');
    expect(mockCancel).toHaveBeenCalledWith(['prep', 'dep']);
  });

  it('도착이 잡히면 준비 · 출발 · 도착 알람 — 기상은 그대로', async () => {
    await settlePhoneAlarms('p-1', 'ARRIVE');
    expect(mockCancel).toHaveBeenCalledWith(['prep', 'dep', 'arr']);
  });

  it('내 알람 중 그 참여 조건의 것만 읽음', async () => {
    await remainingAlarmIds('p-1', 'DEPART');
    const [read] = calls;
    expect(read).toMatchObject({ table: 'alarms', op: 'select' });
    expect(filterArgs(read, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
  });

  it('지울 알람이 없으면 폰을 건드리지 않음', async () => {
    mockHandler = (call) => (call.op === 'select' ? { data: [{ alarm_id: 'wake', alarm_type: 'WAKE' }] } : undefined);
    await settlePhoneAlarms('p-1', 'ARRIVE');
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('읽기 · 지우기가 실패해도 던지지 않음 — 위치 기록은 이미 서버에 있고 다음 맞추기가 같은 일을 함', async () => {
    mockHandler = (call) => (call.op === 'select' ? { error: { message: 'network' } } : undefined);
    await expect(settlePhoneAlarms('p-1', 'DEPART')).resolves.toBeUndefined();
    mockHandler = (call) => (call.op === 'select' ? { data: rows } : undefined);
    mockCancel.mockRejectedValueOnce(new Error('native'));
    await expect(settlePhoneAlarms('p-1', 'DEPART')).resolves.toBeUndefined();
  });
});
