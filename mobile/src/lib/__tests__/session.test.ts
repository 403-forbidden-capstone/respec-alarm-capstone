import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '../errors';
import { cleanupAfterAccountDelete, cleanupAfterDataReset, onSignOut, signOutAndCleanup } from '../session';

// 정리 단계가 정해진 순서로 불리는지 — 각 단계는 가짜로 두고 호출 순서만 기록
const mockCalls: string[] = [];
const mockCancelAll = jest.fn<() => Promise<void>>();
const mockSigningOut = jest.fn<(value: boolean) => void>();
const mockUpload = jest.fn<() => Promise<unknown>>();
const mockDiscard = jest.fn<() => Promise<number>>();
const mockUnsubscribeAll = jest.fn<() => void>();
const mockSignOut = jest.fn<() => Promise<void>>();

jest.mock('../alarmSync', () => ({
  uploadEvents: () => mockUpload(),
  cancelAllPhoneAlarms: () => mockCancelAll(),
  discardPendingEvents: () => mockDiscard(),
  setSigningOut: (value: boolean) => mockSigningOut(value),
}));
jest.mock('../realtime', () => ({ unsubscribeAll: () => mockUnsubscribeAll() }));
jest.mock('../auth', () => ({ signOut: () => mockSignOut() }));

beforeEach(() => {
  mockCalls.length = 0;
  jest.clearAllMocks();
  mockSigningOut.mockImplementation((value) => void mockCalls.push(`로그아웃 중 ${value ? '켜기' : '끄기'}`));
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
  it('로그아웃 중 켜기 → 올려 보기 → 알람 전부 취소 → 남은 기록 버림 → 구독 끊기 → 로그아웃 순서 (끝까지 가면 표시는 켜 둠 — 다시 로그인할 때 useAlarmSync가 끔)', async () => {
    await signOutAndCleanup();
    expect(mockCalls).toEqual(['로그아웃 중 켜기', '올리기', '알람 취소', '남은 기록 버림', '구독 끊기', '로그아웃']);
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
    expect(mockCalls).toEqual(['로그아웃 중 켜기', '올리기', '로그아웃 중 끄기']); // 로그인 상태가 남으므로 맞추기를 다시 돌게
  });

  it('로그아웃 자체가 실패하면 그 오류를 그대로 던짐', async () => {
    mockSignOut.mockRejectedValue(new Error('network'));
    await expect(signOutAndCleanup()).rejects.toThrow('network');
    expect(mockCalls.at(-1)).toBe('로그아웃 중 끄기');
  });
});

describe('시험 데이터 지운 뒤 폰 정리 (로그아웃 없이)', () => {
  it('알람 전부 취소 → 남은 기록 버림 → 구독 끊기까지만 하고, 올리기 · 로그아웃 · 로그아웃 중 표시는 건드리지 않음', async () => {
    await cleanupAfterDataReset();
    expect(mockCalls).toEqual(['알람 취소', '남은 기록 버림', '구독 끊기']);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSigningOut).not.toHaveBeenCalled();
  });

  it('남은 기록을 못 버려도 계속하고 기능이 등록한 메모리 정리도 부름 (하나가 실패해도 나머지는 계속)', async () => {
    const cleanups: string[] = [];
    const offBad = onSignOut(() => {
      throw new Error('정리 실패');
    });
    const offGood = onSignOut(() => void cleanups.push('메모리 정리'));
    mockDiscard.mockRejectedValue(new Error('폰 저장소 오류'));
    await expect(cleanupAfterDataReset()).resolves.toBeUndefined();
    expect(cleanups).toEqual(['메모리 정리']);
    expect(mockUnsubscribeAll).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });

  it('폰 알람을 못 지우면 서버는 지웠다는 것과 함께 이유를 보여 주고 뒤 단계는 하지 않음', async () => {
    mockCancelAll.mockRejectedValue(new Error('native error'));
    const error = await cleanupAfterDataReset().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('서버의 시험 데이터는 지웠지만 폰에 걸린 알람은 지우지 못했어요. 다시 눌러 주세요');
    expect(mockUnsubscribeAll).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('알람 취소 이후 단계의 예외', () => {
  it('로그아웃 정리: 알람 취소 뒤 단계가 던지면 "폰에 걸린 알람을…" 문구로 바꾸지 않고 원문 그대로 전파 (로그아웃은 안 함)', async () => {
    mockUnsubscribeAll.mockImplementation(() => {
      throw new Error('구독 끊기 실패');
    });
    const error = await signOutAndCleanup().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UserError);
    expect((error as Error).message).toBe('구독 끊기 실패');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockCalls.at(-1)).toBe('로그아웃 중 끄기');
  });

  it('시험 데이터 지운 뒤 정리: 알람 취소 뒤 단계가 던지면 원문 그대로 전파', async () => {
    mockUnsubscribeAll.mockImplementation(() => {
      throw new Error('구독 끊기 실패');
    });
    const error = await cleanupAfterDataReset().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UserError);
    expect((error as Error).message).toBe('구독 끊기 실패');
  });
});


describe('계정 삭제 뒤 기기 정리 (친구 12장)', () => {
  it('폰 알람 취소 → 기록 버림 → 구독 끊기 → 로그아웃 — 올리기는 안 함(서버 계정이 이미 없음)', async () => {
    await cleanupAfterAccountDelete();
    expect(mockCalls).toEqual(['로그아웃 중 켜기', '알람 취소', '남은 기록 버림', '구독 끊기', '로그아웃']);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('폰 알람을 못 지워도 · 로그아웃이 서버 오류여도 멈추지 않음 (계정이 이미 지워졌으니 이 기기는 비워야 함)', async () => {
    mockCancelAll.mockRejectedValue(new Error('폰 저장소 오류'));
    mockSignOut.mockRejectedValue(new Error('서버 로그아웃 실패'));
    await expect(cleanupAfterAccountDelete()).resolves.toBeUndefined();
    expect(mockUnsubscribeAll).toHaveBeenCalledTimes(1);
  });
});
