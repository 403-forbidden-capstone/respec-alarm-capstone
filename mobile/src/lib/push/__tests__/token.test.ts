import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { registerPushToken, removePushToken, resetPushToken } from '../token';

// 토큰 등록 · 삭제 (시험케이스 11-01 · 11-02 · 11-03 · 11-04, 세션약속 11/8 S1 → S2)
let mockOS = 'android';
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    get OS() {
      return mockOS;
    },
    select: (o: Record<string, unknown>) => o[mockOS] ?? o.default,
  },
}));

const calls: string[] = [];
const mockEnsure = jest.fn<() => Promise<boolean>>();
jest.mock('../channels', () => ({ ensureNotificationChannels: () => mockEnsure() }));
const mockGetToken = jest.fn<(options?: { projectId?: string }) => Promise<{ data: string }>>();
jest.mock('expo-notifications', () => ({ getExpoPushTokenAsync: (o?: { projectId?: string }) => mockGetToken(o) }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } } }));

const mockRpc = jest.fn<(name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>>();
const mockDeleteEq = jest.fn<(column: string, value: string) => Promise<{ error: unknown }>>();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => mockRpc(name, args),
    from: (table: string) => ({
      delete: () => ({
        eq: (column: string, value: string) => {
          calls.push(`delete ${table}`);
          return mockDeleteEq(column, value);
        },
      }),
    }),
  },
}));

const TOKEN = 'ExponentPushToken[abc]';

beforeEach(() => {
  mockOS = 'android';
  calls.length = 0;
  resetPushToken();
  mockEnsure.mockReset();
  mockEnsure.mockImplementation(async () => {
    calls.push('channels');
    return true;
  });
  mockGetToken.mockReset();
  mockGetToken.mockImplementation(async () => {
    calls.push('token');
    return { data: TOKEN };
  });
  mockRpc.mockReset();
  mockRpc.mockImplementation(async () => {
    calls.push('register');
    return { error: null };
  });
  mockDeleteEq.mockReset();
  mockDeleteEq.mockResolvedValue({ error: null });
});

describe('토큰 등록', () => {
  it('채널을 먼저 만들고 → 토큰을 받고 → register_push_token (플랫폼 android, 프로젝트 id 포함)', async () => {
    await expect(registerPushToken()).resolves.toBe('registered');
    expect(calls).toEqual(['channels', 'token', 'register']);
    expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(mockRpc).toHaveBeenCalledWith('register_push_token', { p_token: TOKEN, p_platform: 'android' });
  });

  it.each(['web', 'ios'])('%s: 아무 일도 안 함', async (os) => {
    mockOS = os;
    await expect(registerPushToken()).resolves.toBe('unsupported');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('토큰을 못 받거나 서버가 거절해도 던지지 않고 failed (로그인 전이라 거절되는 경우 포함)', async () => {
    mockGetToken.mockRejectedValueOnce(new Error('FCM 설정 없음'));
    await expect(registerPushToken()).resolves.toBe('failed');
    mockRpc.mockResolvedValueOnce({ error: { code: '42501' } });
    await expect(registerPushToken()).resolves.toBe('failed');
  });
});

describe('로그아웃 때 토큰 삭제 (11-02)', () => {
  it('등록한 토큰의 행만 지움 — 폰에서 다시 받지 않음', async () => {
    await registerPushToken();
    calls.length = 0;
    await removePushToken();
    expect(mockDeleteEq).toHaveBeenCalledWith('token', TOKEN);
    expect(calls).toEqual(['delete push_tokens']);
  });

  it('등록한 적이 없으면 폰에서 받아서 지움', async () => {
    await removePushToken();
    expect(mockDeleteEq).toHaveBeenCalledWith('token', TOKEN);
  });

  it('지우지 못하면 던짐(부르는 쪽이 삼킴) · 안드로이드가 아니면 아무 일도 안 함', async () => {
    await registerPushToken();
    mockDeleteEq.mockResolvedValueOnce({ error: { message: 'offline' } });
    await expect(removePushToken()).rejects.toBeDefined();
    mockOS = 'web';
    await removePushToken();
    expect(mockDeleteEq).toHaveBeenCalledTimes(1);
  });
});
