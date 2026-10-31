import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { resetMyTestData } from '../api';

// 서버 함수를 부르는지 · 가짜 모드에서 거절하는지 · 오류를 그대로 던지는지 — 진짜 DB는 안 붙임 (지우는 범위는 supabase/tests/db-check.mjs가 확인)
let mockIsMock = false;
const mockRpc = jest.fn<(name: string, args?: unknown) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>>();

jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (name: string, args?: unknown) => mockRpc(name, args) } }));

beforeEach(() => {
  mockIsMock = false;
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: {}, error: null });
});

describe('resetMyTestData', () => {
  it('실데이터에서는 인자 없이 dev_reset_my_data 하나만 부름 (남의 id를 넘길 곳이 없음)', async () => {
    await expect(resetMyTestData()).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('dev_reset_my_data', undefined);
  });

  it('가짜 데이터 모드에서는 서버를 부르지 않고 이유를 보여 줌', async () => {
    mockIsMock = true;
    const error = await resetMyTestData().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('가짜 데이터 모드에서는 지울 게 없어요');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('서버 오류는 원문 그대로 던짐 (화면이 기본 문구로 바꿈)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied for function dev_reset_my_data' } });
    const error = await resetMyTestData().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(UserError);
  });
});
