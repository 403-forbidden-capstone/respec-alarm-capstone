import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { changeDataMode } from '../DataModeToggle';

// 데이터 모드 바꾸기 — /dev/screens · 설정의 토글과 웹 미리보기 왼쪽 패널이 같이 쓰는 함수 (토스트 문구 · 옮겨 가는 화면이 같아야 함)
const mockToast = jest.fn();
jest.mock('@/components/ui', () => ({ Segmented: () => null, toast: (message: string) => mockToast(message) }));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ router: { replace: (href: string) => mockReplace(href) } }));

const mockHasSession = jest.fn<() => Promise<boolean>>();
jest.mock('@/lib/auth', () => ({ hasSession: () => mockHasSession() }));

let mockCurrent: 'real' | 'mock' = 'mock';
const mockSetMode = jest.fn<(next: 'real' | 'mock') => 'real' | 'mock'>();
jest.mock('@/lib/mode', () => ({
  getMode: () => mockCurrent,
  setMode: (next: 'real' | 'mock') => mockSetMode(next),
  useMode: () => ({ mode: mockCurrent, ready: true }),
  modeLocked: false,
}));

// goAfterRender는 setTimeout(0) 뒤에 옮김
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  jest.runAllTimers();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockToast.mockReset();
  mockReplace.mockReset();
  mockHasSession.mockReset();
  mockSetMode.mockReset();
  mockCurrent = 'mock';
});
afterEach(() => {
  jest.useRealTimers();
});

describe('changeDataMode', () => {
  it('지금 모드를 다시 고르면 아무 일도 안 함', async () => {
    await changeDataMode('mock');
    expect(mockSetMode).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('가짜로 바꾸면 토스트 후 처음 화면(/)으로', async () => {
    mockCurrent = 'real';
    mockSetMode.mockReturnValue('mock');
    await changeDataMode('mock');
    await settle();
    expect(mockToast).toHaveBeenCalledWith('가짜 데이터 모드예요. 목업 시나리오로 돌아요');
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('실데이터로 바꿨는데 저장된 로그인이 없으면 로그인 화면으로', async () => {
    mockSetMode.mockReturnValue('real');
    mockHasSession.mockResolvedValue(false);
    await changeDataMode('real');
    await settle();
    expect(mockToast).toHaveBeenCalledWith('실데이터 모드예요');
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  it('실데이터로 바꿨고 로그인이 남아 있으면 처음 화면으로', async () => {
    mockSetMode.mockReturnValue('real');
    mockHasSession.mockResolvedValue(true);
    await changeDataMode('real');
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('로그인 확인이 실패하면 로그인 없음으로 보고 로그인 화면으로', async () => {
    mockSetMode.mockReturnValue('real');
    mockHasSession.mockRejectedValue(new Error('storage'));
    await changeDataMode('real');
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  it('실데이터를 쓸 수 없어 가짜로 남았으면 안내만 하고 화면은 그대로', async () => {
    mockSetMode.mockReturnValue('mock');
    await changeDataMode('real');
    await settle();
    expect(mockToast).toHaveBeenCalledWith('실데이터를 쓸 수 없어 가짜 데이터로 돌아요');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
