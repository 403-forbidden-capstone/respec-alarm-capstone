import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { readLocationTime, recordParticipantTimes } from '@/features/alarm/participantTimes';
import { correctAutoWake, getAutoWake } from '@/features/alarm/realWake';

import { applyFix } from '../fixes';

// 대화 정정 반영 — L2 함수(recordParticipantTimes · readLocationTime)와 고친 값 기록 insert를 가짜로
const mockInserted: Record<string, unknown>[] = [];
let mockInsertError: { code?: string; message: string } | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'user_edit_logs') mockInserted.push(row);
        return { error: mockInsertError };
      },
    }),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
jest.mock('@/features/alarm/participantTimes', () => ({ readLocationTime: jest.fn(), recordParticipantTimes: jest.fn() }));
jest.mock('@/features/alarm/realWake', () => ({ getAutoWake: jest.fn(), correctAutoWake: jest.fn() }));

const mRead = readLocationTime as unknown as jest.Mock<(id: string, kind: string) => Promise<unknown>>;
const mAuto = getAutoWake as unknown as jest.Mock<() => Promise<{ alarmId: string; at: Date } | null>>;
const mCorrect = correctAutoWake as unknown as jest.Mock<(id: string) => Promise<boolean>>;
const mRecord = recordParticipantTimes as unknown as jest.Mock<(input: Record<string, unknown>) => Promise<unknown>>;

const to = new Date('2026-10-30T01:20:00Z');
const fix = { id: 'x1', kind: 'ARRIVE', participantId: 'p-1', action: 'CORRECT' as const, to };

beforeEach(() => {
  jest.clearAllMocks();
  mockInserted.length = 0;
  mockInsertError = null;
  mRead.mockImplementation(async () => ({ participantId: 'p-1', kind: 'ARRIVE', at: Date.parse('2026-10-30T01:07:00Z'), appointmentId: 'ap-1', alarmId: 'al-1' }));
  mRecord.mockImplementation(async () => ({ departed: null, arrived: 'override', prepareMinutes: null, travelMinutes: null }));
});

describe('applyFix', () => {
  it('새 시각은 출처 MANUAL로 쓰고 고친 값 기록(A02)을 한 줄 남김', async () => {
    expect(await applyFix(fix)).toEqual({ id: 'x1', ok: true, error: null });
    expect(mRecord).toHaveBeenCalledWith({ participantId: 'p-1', arrivedAt: to, source: 'MANUAL' });
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0]).toMatchObject({ user_id: 'user-1', appointment_id: 'ap-1', alarm_id: 'al-1', screen: 'A02', field: 'arrived_at', alarm_type: 'ARRIVE', edited_value: to.toISOString() });
    expect(mockInserted[0].auto_value).toBe('2026-10-30T01:07:00.000Z');
  });

  it('출발은 departedAt으로 씀', async () => {
    mRecord.mockImplementation(async () => ({ departed: 'new', arrived: null, prepareMinutes: null, travelMinutes: null }));
    expect((await applyFix({ ...fix, kind: 'DEPART' })).ok).toBe(true);
    expect(mRecord).toHaveBeenCalledWith({ participantId: 'p-1', departedAt: to, source: 'MANUAL' });
  });

  it('원탭 · 직접 값이 이미 있으면(keep) 못 바꿈 — 기록도 안 남김', async () => {
    mRecord.mockImplementation(async () => ({ departed: null, arrived: 'keep', prepareMinutes: null, travelMinutes: null }));
    expect(await applyFix(fix)).toEqual({ id: 'x1', ok: false, error: '이미 확인한 기록' });
    expect(mockInserted).toHaveLength(0);
  });

  it('지워진 참여 조건이면 대상 없음', async () => {
    mRecord.mockImplementation(async () => ({ departed: null, arrived: null, prepareMinutes: null, travelMinutes: null }));
    expect(await applyFix(fix)).toEqual({ id: 'x1', ok: false, error: '대상 없음' });
  });

  it('기록 남기기가 실패해도 시각 정정은 성공', async () => {
    mockInsertError = { code: '42501', message: 'denied' };
    expect((await applyFix(fix)).ok).toBe(true);
  });

  it('부정(위치 값 지우기) · 기상 정정은 아직 안 됨', async () => {
    expect(await applyFix({ ...fix, action: 'DENY', to: null })).toEqual({ id: 'x1', ok: false, error: '아직 안 됨' });
    expect(await applyFix({ ...fix, kind: 'WAKE' })).toEqual({ id: 'x1', ok: false, error: '아직 안 됨' });
    expect(mRecord).not.toHaveBeenCalled();
  });

  it('기상 부정("아직 안 일어났어")은 자동 확정을 취소하는 같은 함수로 — 대상이 없으면 대상 없음, 새 시각 정정은 아직 안 됨', async () => {
    const wakeDeny = { ...fix, kind: 'WAKE', action: 'DENY' as const, to: null };
    mAuto.mockResolvedValue({ alarmId: 'al-w', at: new Date('2026-10-30T22:11:00Z') });
    mCorrect.mockResolvedValue(true);
    expect(await applyFix(wakeDeny)).toEqual({ id: 'x1', ok: true, error: null });
    expect(mCorrect).toHaveBeenCalledWith('al-w');
    mCorrect.mockResolvedValue(false);
    expect(await applyFix(wakeDeny)).toEqual({ id: 'x1', ok: false, error: '대상 없음' });
    mAuto.mockResolvedValue(null);
    expect(await applyFix(wakeDeny)).toEqual({ id: 'x1', ok: false, error: '대상 없음' });
    expect(await applyFix({ ...wakeDeny, action: 'CORRECT' as never })).toEqual({ id: 'x1', ok: false, error: '아직 안 됨' });
  });

  it('새 시각이 없으면 시각 모름', async () => {
    expect(await applyFix({ ...fix, to: null })).toEqual({ id: 'x1', ok: false, error: '시각 모름' });
  });
});
