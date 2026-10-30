import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, type AppStateStatus } from 'react-native';

import { useLocationSync as hook } from '../useLocationSync';

// 훅을 화면 없이 확인 — useEffect를 모아 두었다가 손으로 돌림 (효과 순서는 선언 순서 그대로)
type Effect = () => void | (() => void);
let mockEffects: Effect[] = [];
jest.mock('react', () => ({ ...jest.requireActual<typeof import('react')>('react'), useEffect: (effect: Effect) => void mockEffects.push(effect) }));

const mockSync = jest.fn<(options?: { ignoreThrottle?: boolean }) => Promise<void>>();
const mockClear = jest.fn<() => Promise<void>>();
jest.mock('../register', () => ({ syncLocation: (options?: { ignoreThrottle?: boolean }) => mockSync(options), clearOnSignOut: () => mockClear() }));

let mockSignOutCleanup: (() => void) | null = null;
const mockUnregister = jest.fn();
jest.mock('@/lib/session', () => ({
  onSignOut: (cleanup: () => void) => {
    mockSignOutCleanup = cleanup;
    return mockUnregister;
  },
}));

let mockListener: ((state: AppStateStatus) => void) | null = null;
const mockRemove = jest.fn();

// 훅을 한 번 부르고 효과들을 돌려 정리 함수를 모음
function mount(props: { active: boolean; userId: string | null }) {
  mockEffects = [];
  hook(props); // 화면 밖에서 훅을 직접 부름 — 위에서 useEffect를 가짜로 바꿔 둠
  return mockEffects.map((effect) => effect());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSync.mockResolvedValue(undefined);
  mockClear.mockResolvedValue(undefined);
  mockSignOutCleanup = null;
  mockListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: AppStateStatus) => void) => {
    mockListener = listener;
    return { remove: mockRemove };
  }) as unknown as typeof AppState.addEventListener);
});

describe('useLocationSync', () => {
  it('로그인해 쓸 수 있는 상태가 되면 바로 한 번(5분 제한 없이), 앱이 앞에 올 때마다(5분 제한 안에서) 맞춤', () => {
    mount({ active: true, userId: 'user-1' });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenLastCalledWith({ ignoreThrottle: true });

    mockListener?.('background');
    mockListener?.('inactive');
    expect(mockSync).toHaveBeenCalledTimes(1);
    mockListener?.('active');
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenLastCalledWith(undefined); // 5분 제한은 syncLocation 안에서
  });

  it.each([
    ['로그아웃 상태', { active: true, userId: null }],
    ['앱 화면을 쓸 수 없는 상태 (가짜 모드 · 프로필 읽기 전)', { active: false, userId: 'user-1' }],
  ])('%s: 맞추지 않고 앱 상태도 안 봄', (_name, props) => {
    mount(props);
    expect(mockSync).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it('정리하면 앱 상태 구독을 끊음', () => {
    const cleanups = mount({ active: true, userId: 'user-1' });
    (cleanups[1] as () => void)();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('로그아웃 정리를 lib/session에 등록 — 로그아웃 때 지오펜스를 끄고 위치 기억을 지움 (로그인 전에도 등록)', () => {
    mount({ active: false, userId: null });
    expect(mockSignOutCleanup).toEqual(expect.any(Function));
    mockSignOutCleanup?.();
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('로그아웃 정리가 실패해도 던지지 않음 (로그아웃을 막지 않게)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockClear.mockRejectedValue(new Error('storage'));
    mount({ active: false, userId: null });
    expect(() => mockSignOutCleanup?.()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(1); // 개발 중 콘솔에만 남김
  });
});
