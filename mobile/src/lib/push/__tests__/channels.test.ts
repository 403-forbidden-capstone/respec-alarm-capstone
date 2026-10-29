import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DETECT_CHANNEL_ID, ensureNotificationChannels } from '../channels';

// react-native Platform만 바꿔 가며 확인 (안드로이드 · 웹 · iOS)
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

const mockSetChannel = jest.fn<(id: string, channel: Record<string, unknown>) => Promise<unknown>>();
jest.mock('expo-notifications', () => ({
  AndroidImportance: { LOW: 4 },
  setNotificationChannelAsync: (id: string, channel: Record<string, unknown>) => mockSetChannel(id, channel),
}));

beforeEach(() => {
  mockOS = 'android';
  mockSetChannel.mockReset();
  mockSetChannel.mockResolvedValue(null);
});

describe('알림 채널 만들기 (ensureNotificationChannels)', () => {
  it('안드로이드: 감지 안내 채널을 소리 · 진동 없이 낮은 중요도로 만듦', async () => {
    await ensureNotificationChannels();
    expect(mockSetChannel).toHaveBeenCalledTimes(1);
    expect(mockSetChannel).toHaveBeenCalledWith(DETECT_CHANNEL_ID, {
      name: '자동 기록 확인',
      description: '출발 · 도착을 위치로 자동 기록했을 때 소리 없이 알려요',
      importance: 4, // AndroidImportance.LOW
      sound: null,
      enableVibrate: false,
    });
    expect(DETECT_CHANNEL_ID).toBe('detect_v1');
  });

  it.each(['web', 'ios'])('%s: 채널이 없는 플랫폼이라 아무것도 안 함', async (os) => {
    mockOS = os;
    await ensureNotificationChannels();
    expect(mockSetChannel).not.toHaveBeenCalled();
  });

  it('두 번 불러도 안전 — 같은 id로 다시 설정할 뿐 오류 없음', async () => {
    await ensureNotificationChannels();
    await ensureNotificationChannels();
    expect(mockSetChannel).toHaveBeenCalledTimes(2);
    expect(mockSetChannel.mock.calls.map(([id]) => id)).toEqual([DETECT_CHANNEL_ID, DETECT_CHANNEL_ID]);
  });

  it('채널을 못 만들어도 던지지 않음 (앱 시작을 막지 않게)', async () => {
    mockSetChannel.mockRejectedValue(new Error('native module unavailable'));
    await expect(ensureNotificationChannels()).resolves.toBeUndefined();
  });
});
