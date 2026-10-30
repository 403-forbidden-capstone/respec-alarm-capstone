import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { resetDetectionLinks, useDetectionLinks as hook } from '../hooks/useDetectionLinks';

// 알림 탭 → 정정 화면 이동 — 훅을 화면 없이 확인 (useEffect를 모았다가 손으로 돌림, useLocationSync.test와 같은 방식)
type Effect = () => void | (() => void);
let mockEffects: Effect[] = [];
jest.mock('react', () => ({ ...jest.requireActual<typeof import('react')>('react'), useEffect: (effect: Effect) => void mockEffects.push(effect) }));

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

const mockPush = jest.fn<(href: unknown) => void>();
jest.mock('expo-router', () => ({ router: { push: (href: unknown) => mockPush(href) } }));

type Response = { notification: { date: number; request: { identifier: string; content: { data?: { url?: unknown } } } } };
const response = (url: unknown, id = 'detect-DEPART-p1-1', date = 1000): Response => ({ notification: { date, request: { identifier: id, content: { data: { url } } } } });
const URL_DEPART = 'respecalarm://detection?kind=DEPART&participantId=p1&at=1';

let mockLast: Response | null = null;
let mockListener: ((r: Response) => void) | null = null;
const mockClear = jest.fn();
const mockRemove = jest.fn();
const mockSetHandler = jest.fn<(handler: { handleNotification: (n: unknown) => Promise<Record<string, boolean>> }) => void>();
jest.mock('expo-notifications', () => ({
  getLastNotificationResponse: () => mockLast,
  addNotificationResponseReceivedListener: (listener: (r: Response) => void) => {
    mockListener = listener;
    return { remove: mockRemove };
  },
  clearLastNotificationResponse: () => mockClear(),
  setNotificationHandler: (handler: { handleNotification: (n: unknown) => Promise<Record<string, boolean>> }) => mockSetHandler(handler),
}));

// 훅을 한 번 부르고 효과들을 돌려 정리 함수를 모음
function mount(active: boolean) {
  mockEffects = [];
  hook({ active }); // 화면 밖에서 훅을 직접 부름 — 위에서 useEffect를 가짜로 바꿔 둠
  return mockEffects.map((effect) => effect());
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDetectionLinks();
  mockOS = 'android';
  mockLast = null;
  mockListener = null;
});

const ROUTE = { pathname: '/detection', params: { kind: 'DEPART', participantId: 'p1', at: '1' } };

describe('useDetectionLinks', () => {
  it('앱이 꺼진 채 알림으로 열림: 마지막 응답을 읽어 정정 화면으로, 한 번만', () => {
    mockLast = response(URL_DEPART);
    mount(true);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(ROUTE);
    expect(mockClear).toHaveBeenCalledTimes(1); // 폰 쪽 마지막 응답도 지움
    mount(true); // 다시 그려지거나 훅이 한 번 더 붙어도 같은 응답은 다시 처리하지 않음
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('앱이 켜진 동안 누르면 리스너가 받아 이동', () => {
    mount(true);
    expect(mockPush).not.toHaveBeenCalled();
    mockListener?.(response(URL_DEPART));
    expect(mockPush).toHaveBeenCalledWith(ROUTE);
    mockListener?.(response(URL_DEPART)); // 같은 알림 응답이 또 오면 무시
    expect(mockPush).toHaveBeenCalledTimes(1);
    mockListener?.(response(URL_DEPART, 'detect-DEPART-p1-1', 2000)); // 같은 번호라도 새로 눌렀으면(시각이 다름) 이동
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('화면을 열 수 없는 동안(로그인 전)에는 기억만 해 두고, 열리면 이동', () => {
    mockLast = response(URL_DEPART);
    mount(false);
    expect(mockPush).not.toHaveBeenCalled();
    mount(true);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('감지 안내가 아닌 알림(주소가 다르거나 없음)은 이동하지 않음', () => {
    mount(true);
    mockListener?.(response('respecalarm://alarm/1', 'other-1'));
    mockListener?.(response(undefined, 'other-2'));
    mockListener?.(response(42, 'other-3'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('정리 함수는 리스너를 뗌', () => {
    const cleanups = mount(true);
    cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup());
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('앞에 떠 있는 동안 감지 안내만 소리 없이 보임', async () => {
    mount(true);
    const handler = mockSetHandler.mock.calls[0][0];
    const notice = { request: { content: { data: { url: URL_DEPART } } } };
    expect(await handler.handleNotification(notice)).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    expect(await handler.handleNotification({ request: { content: { data: {} } } })).toMatchObject({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false });
  });

  it.each(['web', 'ios'])('%s: 아무것도 붙이지 않음', (os) => {
    mockOS = os;
    mockLast = response(URL_DEPART);
    mount(true);
    expect(mockListener).toBeNull();
    expect(mockSetHandler).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
