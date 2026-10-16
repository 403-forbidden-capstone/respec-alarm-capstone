import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { signOut } from '../auth';
import { UserError } from '../errors';

// auth.ts가 불러오는 expo 모듈은 시험에 필요 없음 (스킴 설정이 없는 jest에서 createURL이 던짐)
jest.mock('expo-linking', () => ({ createURL: (path: string) => `respecalarm://${path}` }));
jest.mock('expo-web-browser', () => ({}));

const mockSignOut = jest.fn<() => Promise<{ error: { message: string } | null }>>();
const mockGetSession = jest.fn<() => Promise<{ data: { session: unknown } }>>();
jest.mock('../supabase', () => ({ supabase: { auth: { signOut: () => mockSignOut(), getSession: () => mockGetSession() } } }));

beforeEach(() => {
  mockSignOut.mockReset();
  mockGetSession.mockReset();
});

describe('낮은 층 로그아웃 (signOut)', () => {
  it('서버에 알리다 네트워크로 실패해도 이 기기의 로그인이 지워졌으면 오류 없이 끝남 — "로그아웃하지 못했어요"가 뜨는데 실제로는 로그아웃되는 일이 없게', async () => {
    mockSignOut.mockResolvedValue({ error: { message: 'Network request failed' } });
    mockGetSession.mockResolvedValue({ data: { session: null } }); // supabase-js는 실패해도 이 기기의 세션을 먼저 지움
    await expect(signOut()).resolves.toBeUndefined();
  });

  it('오류인데 이 기기에 로그인이 남아 있으면 이유를 UserError로 (원문은 숨김)', async () => {
    mockSignOut.mockResolvedValue({ error: { message: 'storage unavailable' } });
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    const error = await signOut().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('로그아웃하지 못했어요. 다시 해 주세요');
  });

  it('성공하면 세션을 다시 확인하지 않음', async () => {
    mockSignOut.mockResolvedValue({ error: null });
    await signOut();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
