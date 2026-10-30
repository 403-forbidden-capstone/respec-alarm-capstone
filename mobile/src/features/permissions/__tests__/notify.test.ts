import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { askNotifications } from '../notify';

// react-native · 알람 코어 · 안내 시트를 가짜로 — 어느 갈래에서 무엇을 부르는지만 확인 (기록은 jest.setup.js의 메모리 AsyncStorage)
let mockOs = 'android';
let mockVersion = 34;
let mockAvailable = true;
const mockCheck = jest.fn<(permission: string) => Promise<boolean>>();
const mockRequest = jest.fn<(permission: string) => Promise<string>>();
const mockSendIntent = jest.fn<(action: string, extras?: unknown) => Promise<void>>();
const mockOpenSettings = jest.fn<() => Promise<void>>();
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOs;
    },
    get Version() {
      return mockVersion;
    },
  },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: (permission: string) => mockCheck(permission),
    request: (permission: string) => mockRequest(permission),
  },
  Linking: {
    sendIntent: (action: string, extras?: unknown) => mockSendIntent(action, extras),
    openSettings: () => mockOpenSettings(),
  },
}));
jest.mock('@capstone/alarm-core', () => ({
  __esModule: true,
  get isAvailable() {
    return mockAvailable;
  },
}));
jest.mock('@/lib/mode', () => ({ isMock: () => false })); // read.ts가 가져옴 — supabase 클라이언트를 끌어오지 않게
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { android: { package: 'com.example.app' } } } }));

const mockPrompt = jest.fn<(opts: { title: string; message: string; okLabel: string; cancelLabel: string }) => Promise<boolean>>();
jest.mock('../components/PermissionPromptHost', () => ({
  showNotifyPrompt: (opts: { title: string; message: string; okLabel: string; cancelLabel: string }) => mockPrompt(opts),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockOs = 'android';
  mockVersion = 34;
  mockAvailable = true;
  mockCheck.mockResolvedValue(false);
  mockRequest.mockResolvedValue('granted');
  mockSendIntent.mockResolvedValue();
  mockOpenSettings.mockResolvedValue();
  mockPrompt.mockResolvedValue(true);
});

describe('askNotifications — 알림 허용 묻기', () => {
  it('웹 · 옛 APK(알람 코어 없음)는 아무 창도 없이 unsupported', async () => {
    mockAvailable = false;
    expect(await askNotifications('alarm')).toBe('unsupported');
    mockAvailable = true;
    mockOs = 'web';
    expect(await askNotifications('settings')).toBe('unsupported');
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("'alarm' 처음: 안내 시트 → [켜기] → 시스템 창에서 허용하면 granted", async () => {
    expect(await askNotifications('alarm')).toBe('granted');
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPrompt.mock.calls[0][0]).toMatchObject({ okLabel: '알림 켜기', cancelLabel: '나중에' });
    expect(mockRequest).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
  });

  it("'alarm' 두 번째는 시트도 시스템 창도 없이 denied — 조르지 않음", async () => {
    mockPrompt.mockResolvedValue(false); // 첫 번째에서 "나중에"
    expect(await askNotifications('alarm')).toBe('denied');
    expect(await askNotifications('alarm')).toBe('denied');
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('두 번 거절해 막힌(blocked) 뒤의 [켜기]는 시스템 창 대신 앱 알림 설정을 엶', async () => {
    mockRequest.mockResolvedValueOnce('never_ask_again');
    expect(await askNotifications('settings')).toBe('blocked'); // 이 순간에는 설정을 열지 않고 기록만
    expect(mockSendIntent).not.toHaveBeenCalled();

    mockRequest.mockClear();
    expect(await askNotifications('settings')).toBe('blocked');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSendIntent).toHaveBeenCalledWith('android.settings.APP_NOTIFICATION_SETTINGS', [
      { key: 'android.provider.extra.APP_PACKAGE', value: 'com.example.app' },
    ]);
  });
});
