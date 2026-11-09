import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DETECT_CHANNEL_ID, ensureNotificationChannels, PUSH_CHANNELS } from '../channels';

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
  AndroidImportance: { LOW: 2, DEFAULT: 3, HIGH: 4 },
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
    expect(mockSetChannel).toHaveBeenCalledWith(DETECT_CHANNEL_ID, {
      name: '자동 기록 확인',
      description: '출발 · 도착을 위치로 자동 기록했을 때 소리 없이 알려요',
      importance: 2, // AndroidImportance.LOW
      sound: null,
      enableVibrate: false,
    });
    expect(DETECT_CHANNEL_ID).toBe('detect_v1');
  });

  it('푸시 채널 5개도 만듦 — 서버가 싣는 채널 id(push-copy CHANNEL_IDS)와 같은 이름, 알람 코어 채널과 안 겹침 (11-26)', async () => {
    await ensureNotificationChannels();
    const ids = mockSetChannel.mock.calls.map(([id]) => id);
    expect(ids).toEqual([DETECT_CHANNEL_ID, 'friend_v1', 'alarm_change_v1', 'request_v1', 'group_v1', 'missed_v1']);
    expect(ids).not.toContain('alarm_notice_v1');
    expect(ids).not.toContain('wake_alarm_native_v1');
    expect(PUSH_CHANNELS.find((c) => c.id === 'friend_v1')).toMatchObject({ importance: 'HIGH' });
    expect(mockSetChannel).toHaveBeenCalledWith('request_v1', expect.objectContaining({ importance: 3 }));
  });

  it.each(['web', 'ios'])('%s: 채널이 없는 플랫폼이라 아무것도 안 함', async (os) => {
    mockOS = os;
    await ensureNotificationChannels();
    expect(mockSetChannel).not.toHaveBeenCalled();
  });

  it('두 번 불러도 안전 — 같은 id로 다시 설정할 뿐 오류 없음', async () => {
    await ensureNotificationChannels();
    await ensureNotificationChannels();
    expect(mockSetChannel).toHaveBeenCalledTimes(12);
    expect(mockSetChannel.mock.calls.slice(0, 6)).toEqual(mockSetChannel.mock.calls.slice(6));
  });

  it('채널을 못 만들어도 던지지 않음 (앱 시작을 막지 않게)', async () => {
    mockSetChannel.mockRejectedValue(new Error('native module unavailable'));
    await expect(ensureNotificationChannels()).resolves.toBe(false);
    expect(mockSetChannel).toHaveBeenCalledTimes(6); // 하나가 실패해도 나머지는 계속 만들어 봄
  });
});
