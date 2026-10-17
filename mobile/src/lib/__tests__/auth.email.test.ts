import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { signInWithEmail } from '../auth';
import { UserError } from '../errors';

// auth.ts가 불러오는 expo 모듈은 시험에 필요 없음 (스킴 설정이 없는 jest에서 createURL이 던짐)
jest.mock('expo-linking', () => ({ createURL: (path: string) => `respecalarm://${path}` }));
jest.mock('expo-web-browser', () => ({}));

const mockSignInWithPassword = jest.fn<(credentials: { email: string; password: string }) => Promise<{ data: { session: unknown }; error: { code?: string; message: string } | null }>>();
jest.mock('../supabase', () => ({ supabase: { auth: { signInWithPassword: (credentials: { email: string; password: string }) => mockSignInWithPassword(credentials) } } }));

beforeEach(() => {
  mockSignInWithPassword.mockReset();
});

describe('개발 메뉴 이메일 로그인', () => {
  it('이메일 앞뒤 공백을 지우고 비밀번호는 그대로 보냄', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    await expect(signInWithEmail('  demo-me@example.com ', ' pw ')).resolves.toEqual({ access_token: 't' });
    expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: 'demo-me@example.com', password: ' pw ' });
  });

  it('틀린 계정 · 이메일 로그인이 꺼진 프로젝트는 이유를 보여 줌', async () => {
    mockSignInWithPassword.mockResolvedValueOnce({ data: { session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } });
    await expect(signInWithEmail('a@b.c', 'x')).rejects.toMatchObject({ message: '이메일이나 비밀번호가 맞지 않아요' });
    mockSignInWithPassword.mockResolvedValueOnce({ data: { session: null }, error: { code: 'email_provider_disabled', message: 'Email logins are disabled' } });
    const disabled = await signInWithEmail('a@b.c', 'x').catch((e: unknown) => e);
    expect(disabled).toBeInstanceOf(UserError);
  });

  it('그 밖의 오류는 원문을 그대로 던져 화면이 기본 문구로 바꾸게 함 (UserError가 아님)', async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { session: null }, error: { code: 'unexpected_failure', message: 'fetch failed' } });
    const error = await signInWithEmail('a@b.c', 'x').catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UserError);
  });
});
