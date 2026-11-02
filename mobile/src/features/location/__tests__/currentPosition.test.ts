import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { LOCATE_TIMEOUT_MS, locateOnce } from '../currentPosition';

// 지금 위치 한 번 — 안드로이드에서만 expo-location을 부름. 권한은 앞(앱 사용 중)만 물음
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

const mockAsk = jest.fn<() => Promise<{ granted: boolean }>>();
const mockBackground = jest.fn<() => Promise<{ granted: boolean }>>();
const mockPosition = jest.fn<(options: { accuracy: number }) => Promise<{ coords: { latitude: number; longitude: number } }>>();
const mockLastKnown = jest.fn<(options: { maxAge: number }) => Promise<{ coords: { latitude: number; longitude: number } } | null>>();
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: () => mockAsk(),
  requestBackgroundPermissionsAsync: () => mockBackground(),
  getCurrentPositionAsync: (options: { accuracy: number }) => mockPosition(options),
  getLastKnownPositionAsync: (options: { maxAge: number }) => mockLastKnown(options),
}));

beforeEach(() => {
  mockOS = 'android';
  mockAsk.mockReset().mockResolvedValue({ granted: true });
  mockBackground.mockReset();
  mockPosition.mockReset().mockResolvedValue({ coords: { latitude: 37.55, longitude: 127.07 } });
  mockLastKnown.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('locateOnce', () => {
  it('앞 권한을 물어 허용이면 균형 정확도로 한 번 읽어 {lat, lng}', async () => {
    await expect(locateOnce()).resolves.toEqual({ lat: 37.55, lng: 127.07 });
    expect(mockPosition).toHaveBeenCalledWith({ accuracy: 3 });
    expect(mockBackground).not.toHaveBeenCalled(); // 백그라운드 권한은 건드리지 않음
  });

  it('권한을 거절하면 null (위치는 읽지 않음)', async () => {
    mockAsk.mockResolvedValue({ granted: false });
    await expect(locateOnce()).resolves.toBeNull();
    expect(mockPosition).not.toHaveBeenCalled();
  });

  it('읽기가 실패하거나 좌표가 숫자가 아니면 null', async () => {
    mockPosition.mockRejectedValue(new Error('location unavailable'));
    await expect(locateOnce()).resolves.toBeNull();
    mockPosition.mockResolvedValue({ coords: { latitude: Number.NaN, longitude: 127 } });
    await expect(locateOnce()).resolves.toBeNull();
  });

  it('현재 위치 읽기가 실패하면 5분 안의 마지막 위치로 대신함', async () => {
    mockPosition.mockRejectedValue(new Error('location unavailable'));
    mockLastKnown.mockResolvedValue({ coords: { latitude: 37.5, longitude: 127.0 } });
    await expect(locateOnce()).resolves.toEqual({ lat: 37.5, lng: 127.0 });
    expect(mockLastKnown).toHaveBeenCalledWith({ maxAge: 5 * 60 * 1000 });
  });

  it('8초 안에 현재 위치가 안 오면 마지막 위치로 (그것도 없으면 null)', async () => {
    jest.useFakeTimers();
    mockPosition.mockReturnValue(new Promise(() => {})); // 영영 안 옴
    mockLastKnown.mockResolvedValue({ coords: { latitude: 37.5, longitude: 127.0 } });
    const found = locateOnce();
    await jest.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS - 1);
    expect(mockLastKnown).not.toHaveBeenCalled(); // 아직 기다리는 중
    await jest.advanceTimersByTimeAsync(1);
    await expect(found).resolves.toEqual({ lat: 37.5, lng: 127.0 });

    mockLastKnown.mockResolvedValue(null);
    const none = locateOnce();
    await jest.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS);
    await expect(none).resolves.toBeNull();
  });

  it('iOS는 null (권한도 묻지 않음)', async () => {
    mockOS = 'ios';
    await expect(locateOnce()).resolves.toBeNull();
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('웹은 브라우저 위치를 읽고 실패하면 null', async () => {
    mockOS = 'web';
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const getCurrentPosition = jest.fn<(success: (position: unknown) => void, failure: () => void) => void>();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: { getCurrentPosition } } });
    try {
      getCurrentPosition.mockImplementationOnce((success) => success({ coords: { latitude: 37.55, longitude: 127.07 } }));
      await expect(locateOnce()).resolves.toEqual({ lat: 37.55, lng: 127.07 });
      getCurrentPosition.mockImplementationOnce((_success, failure) => failure());
      await expect(locateOnce()).resolves.toBeNull();
      expect(mockAsk).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
