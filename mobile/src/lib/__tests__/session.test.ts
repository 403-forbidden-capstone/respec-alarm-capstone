import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '../errors';
import { signOutAndCleanup } from '../session';

// 정리 단계가 정해진 순서로 불리는지 — 각 단계는 가짜로 두고 호출 순서만 기록
const mockCalls: string[] = [];
const mockCancelAll = jest.fn<() => Promise<void>>();
const mockUpload = jest.fn<() => Promise<unknown>>();
const mockDiscard = jest.fn<() => Promise<number>>();
const mockUnsubscribeAll = jest.fn<() => void>();
const mockSignOut = jest.fn<() => Promise<void>>();

jest.mock('@capstone/alarm-core', () => ({ cancelAll: () => mockCancelAll() }));
jest.mock('../alarmSync', () => ({ uploadEvents: () => mockUpload(), discardPendingEvents: () => mockDiscard() }));
jest.mock('../realtime', () => ({ unsubscribeAll: () => mockUnsubscribeAll() }));
jest.mock('../auth', () => ({ signOut: () => mockSignOut() }));

beforeEach(() => {
  mockCalls.length = 0;
  jest.clearAllMocks();
  mockUpload.mockImplementation(async () => void mockCalls.push('올리기'));
  mockCancelAll.mockImplementation(async () => void mockCalls.push('알람 취소'));
  mockDiscard.mockImplementation(async () => {
    mockCalls.push('남은 기록 버림');
    return 0;
  });
  mockUnsubscribeAll.mockImplementation(() => void mockCalls.push('구독 끊기'));
  mockSignOut.mockImplementation(async () => void mockCalls.push('로그아웃'));
});

describe('로그아웃 정리', () => {
  it('올려 보기 → 알람 전부 취소 → 남은 기록 버림 → 구독 끊기 → 로그아웃 순서', async () => {
    await signOutAndCleanup();
    expect(mockCalls).toEqual(['올리기', '알람 취소', '남은 기록 버림', '구독 끊기', '로그아웃']);
  });

  it('기록을 못 올려도 · 못 버려도 로그아웃은 계속', async () => {
    mockUpload.mockRejectedValue(new Error('오프라인'));
    mockDiscard.mockRejectedValue(new Error('폰 저장소 오류'));
    await expect(signOutAndCleanup()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribeAll).toHaveBeenCalledTimes(1);
  });

  it('폰 알람을 못 지우면 로그아웃하지 않고 이유를 보여 줌 (앞 계정의 알람이 폰에 남지 않게)', async () => {
    mockCancelAll.mockRejectedValue(new Error('native error'));
    const error = await signOutAndCleanup().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('폰에 걸린 알람을 지우지 못해 로그아웃하지 못했어요. 다시 해 주세요');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockUnsubscribeAll).not.toHaveBeenCalled();
  });

  it('로그아웃 자체가 실패하면 그 오류를 그대로 던짐', async () => {
    mockSignOut.mockRejectedValue(new Error('network'));
    await expect(signOutAndCleanup()).rejects.toThrow('network');
  });
});
