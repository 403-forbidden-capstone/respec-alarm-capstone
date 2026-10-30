import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Linking } from 'react-native';

import { getLocationStatus, openLocationSettings, requestLocationAccess, setLocationAuto, statusOf } from '../permissions';

// 위치 권한 2단계 — expo-location · 등록(register) · 저장(store)은 가짜로 두고 부른 내용을 확인
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

type Granted = { granted: boolean; android?: { accuracy: 'fine' | 'coarse' | 'none' } };
const mockFg = jest.fn<() => Promise<Granted>>();
const mockBg = jest.fn<() => Promise<Granted>>();
const mockRequestFg = jest.fn<() => Promise<Granted>>();
const mockRequestBg = jest.fn<() => Promise<Granted>>();
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: () => mockFg(),
  getBackgroundPermissionsAsync: () => mockBg(),
  requestForegroundPermissionsAsync: () => mockRequestFg(),
  requestBackgroundPermissionsAsync: () => mockRequestBg(),
}));

let mockIsMock = false;
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));

const mockSync = jest.fn<(options?: { ignoreThrottle?: boolean }) => Promise<void>>();
const mockStopGeofences = jest.fn<() => Promise<void>>();
jest.mock('../register', () => ({
  syncLocation: (options?: { ignoreThrottle?: boolean }) => mockSync(options),
  stopGeofences: () => mockStopGeofences(),
}));
const mockSave = jest.fn<(on: boolean) => Promise<void>>();
jest.mock('../store', () => ({ setLocationAuto: (on: boolean) => mockSave(on) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // 실패 경로의 개발용 로그가 시험 출력에 안 섞이게
  mockOS = 'android';
  mockIsMock = false;
  mockFg.mockResolvedValue({ granted: true, android: { accuracy: 'fine' } });
  mockBg.mockResolvedValue({ granted: true });
  mockRequestFg.mockResolvedValue({ granted: true });
  mockSync.mockResolvedValue(undefined);
  mockStopGeofences.mockResolvedValue(undefined);
  mockSave.mockResolvedValue(undefined);
});

describe('statusOf', () => {
  it('앞 권한이 없으면 꺼짐 — 정확도 · 뒤 권한과 상관없이', () => {
    expect(statusOf({ foreground: false, background: false })).toBe('off');
    expect(statusOf({ foreground: false, background: true, accuracy: 'coarse' })).toBe('off');
  });

  it('대략적 위치만이면 정확한 위치 꺼짐 — 항상 허용이어도', () => {
    expect(statusOf({ foreground: true, background: true, accuracy: 'coarse' })).toBe('coarse');
    expect(statusOf({ foreground: true, background: false, accuracy: 'coarse' })).toBe('coarse');
  });

  it('앞 권한만 있으면 앱 사용 중에만', () => {
    expect(statusOf({ foreground: true, background: false, accuracy: 'fine' })).toBe('foreground-only');
    expect(statusOf({ foreground: true, background: false })).toBe('foreground-only');
  });

  it('항상 허용 + 정확한 위치(또는 정확도를 모름)면 켜짐', () => {
    expect(statusOf({ foreground: true, background: true, accuracy: 'fine' })).toBe('on');
    expect(statusOf({ foreground: true, background: true })).toBe('on');
  });
});

describe('getLocationStatus', () => {
  it('읽은 권한으로 상태를 정함', async () => {
    expect(await getLocationStatus()).toBe('on');
    mockBg.mockResolvedValue({ granted: false });
    expect(await getLocationStatus()).toBe('foreground-only');
    mockFg.mockResolvedValue({ granted: true, android: { accuracy: 'coarse' } });
    expect(await getLocationStatus()).toBe('coarse');
    mockFg.mockResolvedValue({ granted: false });
    expect(await getLocationStatus()).toBe('off');
  });

  it('웹 · 안드로이드 아님 · 가짜 데이터는 unsupported이고 expo-location을 안 부름', async () => {
    mockOS = 'web';
    expect(await getLocationStatus()).toBe('unsupported');
    mockOS = 'ios';
    expect(await getLocationStatus()).toBe('unsupported');
    mockOS = 'android';
    mockIsMock = true;
    expect(await getLocationStatus()).toBe('unsupported');
    expect(mockFg).not.toHaveBeenCalled();
    expect(mockBg).not.toHaveBeenCalled();
  });

  it('읽다가 실패하면 던지지 않고 꺼짐', async () => {
    mockFg.mockRejectedValue(new Error('native'));
    expect(await getLocationStatus()).toBe('off');
  });
});

describe('requestLocationAccess', () => {
  it('앞 권한을 받으면 거기서 끝 — 뒤 권한은 요청하지 않고 지금 상태를 돌려줌', async () => {
    mockBg.mockResolvedValue({ granted: false });
    expect(await requestLocationAccess()).toEqual({ foreground: true, background: false });
    expect(mockRequestFg).toHaveBeenCalledTimes(1);
    expect(mockRequestBg).not.toHaveBeenCalled();
  });

  it('앞 권한을 받았는데 뒤 권한이 이미 있으면 그 값 그대로', async () => {
    expect(await requestLocationAccess()).toEqual({ foreground: true, background: true });
    expect(mockRequestBg).not.toHaveBeenCalled();
  });

  it('앞 권한을 거절하면(다시 묻지 않음 포함) 둘 다 false이고 뒤 권한은 읽지도 않음', async () => {
    mockRequestFg.mockResolvedValue({ granted: false });
    expect(await requestLocationAccess()).toEqual({ foreground: false, background: false });
    expect(mockBg).not.toHaveBeenCalled();
    expect(mockRequestBg).not.toHaveBeenCalled();
  });

  it('요청이 실패해도 던지지 않음', async () => {
    mockRequestFg.mockRejectedValue(new Error('native'));
    expect(await requestLocationAccess()).toEqual({ foreground: false, background: false });
  });

  it('웹 · 가짜 데이터는 아무것도 안 부름', async () => {
    mockOS = 'web';
    expect(await requestLocationAccess()).toEqual({ foreground: false, background: false });
    mockOS = 'android';
    mockIsMock = true;
    expect(await requestLocationAccess()).toEqual({ foreground: false, background: false });
    expect(mockRequestFg).not.toHaveBeenCalled();
  });
});

describe('openLocationSettings', () => {
  it('앱 설정 화면을 엶', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await openLocationSettings();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('setLocationAuto', () => {
  it('켜면 저장하고 바로 등록 (5분 제한 없이)', async () => {
    await setLocationAuto(true);
    expect(mockSave).toHaveBeenCalledWith(true);
    expect(mockSync).toHaveBeenCalledWith({ ignoreThrottle: true });
    expect(mockStopGeofences).not.toHaveBeenCalled();
  });

  it('끄면 저장하고 등록한 지오펜스를 멈춤', async () => {
    await setLocationAuto(false);
    expect(mockSave).toHaveBeenCalledWith(false);
    expect(mockStopGeofences).toHaveBeenCalledTimes(1);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('저장이 실패하면 던지지 않고 등록 · 멈춤도 하지 않음', async () => {
    mockSave.mockRejectedValue(new Error('storage'));
    await expect(setLocationAuto(true)).resolves.toBeUndefined();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('등록이 실패해도 던지지 않음', async () => {
    mockSync.mockRejectedValue(new Error('network'));
    await expect(setLocationAuto(true)).resolves.toBeUndefined();
    mockStopGeofences.mockRejectedValue(new Error('storage'));
    await expect(setLocationAuto(false)).resolves.toBeUndefined();
  });
});
