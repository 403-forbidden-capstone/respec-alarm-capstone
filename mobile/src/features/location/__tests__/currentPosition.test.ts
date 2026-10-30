import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { locateOnce } from '../currentPosition';

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
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: () => mockAsk(),
  requestBackgroundPermissionsAsync: () => mockBackground(),
  getCurrentPositionAsync: (options: { accuracy: number }) => mockPosition(options),
}));

beforeEach(() => {
  mockOS = 'android';
  mockAsk.mockReset().mockResolvedValue({ granted: true });
  mockBackground.mockReset();
  mockPosition.mockReset().mockResolvedValue({ coords: { latitude: 37.55, longitude: 127.07 } });
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

  it('웹 · iOS는 null (권한도 묻지 않음)', async () => {
    mockOS = 'web';
    await expect(locateOnce()).resolves.toBeNull();
    mockOS = 'ios';
    await expect(locateOnce()).resolves.toBeNull();
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
