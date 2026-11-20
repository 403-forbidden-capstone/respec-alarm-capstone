import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { signInWithProvider, signOut } from '../auth';

// 카카오 로그인 길 고르기 — SDK가 되는 폰 빌드는 카카오톡 → ID 토큰 → Supabase, 아니면 지금처럼 브라우저
jest.mock('expo-linking', () => ({ createURL: (path: string) => `respecalarm://${path}` }));
const mockOpenAuthSession = jest.fn<() => Promise<{ type: string; url?: string }>>();
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: () => mockOpenAuthSession() }));

const mockAvailable = jest.fn<() => boolean>();
const mockIdToken = jest.fn<() => Promise<string | null>>();
const mockKakaoLogout = jest.fn<() => Promise<void>>();
jest.mock('../kakaoSdk', () => ({
  kakaoSdkAvailable: () => mockAvailable(),
  kakaoIdToken: () => mockIdToken(),
  kakaoSdkLogout: () => mockKakaoLogout(),
}));

type Result = { data: unknown; error: { message: string } | null };
const mockSignInWithIdToken = jest.fn<(args: unknown) => Promise<Result>>();
const mockSignInWithOAuth = jest.fn<(args: unknown) => Promise<Result>>();
const mockSignOut = jest.fn<() => Promise<{ error: null }>>();
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInWithIdToken: (args: unknown) => mockSignInWithIdToken(args),
      signInWithOAuth: (args: unknown) => mockSignInWithOAuth(args),
      signOut: () => mockSignOut(),
    },
  },
}));

const session = { access_token: 'a', refresh_token: 'r' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAvailable.mockReturnValue(true);
  mockKakaoLogout.mockResolvedValue(undefined);
  mockSignOut.mockResolvedValue({ error: null });
  mockSignInWithOAuth.mockResolvedValue({ data: { url: 'https://example.supabase.co/auth/v1/authorize' }, error: null });
  mockOpenAuthSession.mockResolvedValue({ type: 'cancel' });
});

describe('카카오 SDK 로그인 (signInWithProvider)', () => {
  it('SDK가 되면 카카오 ID 토큰을 Supabase에 넘기고 브라우저는 안 염', async () => {
    mockIdToken.mockResolvedValue('kakao-id-token');
    mockSignInWithIdToken.mockResolvedValue({ data: { session }, error: null });
    await expect(signInWithProvider('kakao')).resolves.toBe(session);
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'kakao', token: 'kakao-id-token' });
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
    expect(mockOpenAuthSession).not.toHaveBeenCalled();
  });

  it('카카오 동의 창을 닫으면 null — Supabase는 안 부름', async () => {
    mockIdToken.mockResolvedValue(null);
    await expect(signInWithProvider('kakao')).resolves.toBeNull();
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it('Supabase가 토큰을 안 받으면(키 설정 빠짐 등) 오류를 그대로 던짐 — 화면은 "로그인하지 못했어요"', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockIdToken.mockResolvedValue('kakao-id-token');
    mockSignInWithIdToken.mockResolvedValue({ data: null, error: { message: 'Unacceptable audience in id_token' } });
    await expect(signInWithProvider('kakao')).rejects.toEqual({ message: 'Unacceptable audience in id_token' });
    warn.mockRestore();
  });

  it('SDK가 안 되는 빌드(키 없음 · 옛 개발 빌드 · 웹)는 지금처럼 브라우저 로그인', async () => {
    mockAvailable.mockReturnValue(false);
    await expect(signInWithProvider('kakao')).resolves.toBeNull(); // 브라우저 창을 닫은 경우
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'kakao' }));
    expect(mockIdToken).not.toHaveBeenCalled();
  });

  it('구글은 SDK가 되는 빌드에서도 브라우저 로그인', async () => {
    await signInWithProvider('google');
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
    expect(mockIdToken).not.toHaveBeenCalled();
  });
});

describe('로그아웃 때 카카오 토큰 정리', () => {
  it('우리 앱 로그아웃 뒤 카카오 SDK 로그아웃도 부름', async () => {
    await signOut();
    expect(mockKakaoLogout).toHaveBeenCalledTimes(1);
  });
});
