import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform, TurboModuleRegistry } from 'react-native';

import { UserError } from '../errors';
import { kakaoIdToken, kakaoSdkAvailable, kakaoSdkLogout } from '../kakaoSdk';

// 카카오 SDK 감싸기 — 키 · 네이티브 모듈이 있을 때만 쓰고, 닫기는 null, ID 토큰이 없으면 해요체 오류
const mockExtra: { kakaoNativeAppKey?: string } = { kakaoNativeAppKey: 'native-key' };
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { get extra() { return mockExtra; } } } }));

const mockInit = jest.fn<(key: string) => Promise<void>>();
jest.mock('@react-native-kakao/core', () => ({ initializeKakaoSDK: (key: string) => mockInit(key) }));
const mockLogin = jest.fn<() => Promise<{ idToken?: string }>>();
const mockLogout = jest.fn<() => Promise<void>>();
jest.mock('@react-native-kakao/user', () => ({ login: () => mockLogin(), logout: () => mockLogout() }));

const getModule = jest.spyOn(TurboModuleRegistry, 'get');

beforeEach(() => {
  jest.clearAllMocks();
  mockExtra.kakaoNativeAppKey = 'native-key';
  getModule.mockReturnValue({} as never);
  mockInit.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
});

describe('kakaoSdkAvailable', () => {
  it('키가 빌드에 있고 네이티브 모듈이 있으면 씀', () => {
    expect(kakaoSdkAvailable()).toBe(true);
  });

  it('키가 없으면 안 씀 (KAKAO_NATIVE_APP_KEY 없이 만든 빌드)', () => {
    mockExtra.kakaoNativeAppKey = undefined;
    expect(kakaoSdkAvailable()).toBe(false);
  });

  it('네이티브 모듈이 없으면 안 씀 (이 PR 전에 만든 개발 빌드에 새 JS를 띄운 경우)', () => {
    getModule.mockReturnValue(null);
    expect(kakaoSdkAvailable()).toBe(false);
  });

  it('웹은 안 씀', () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      expect(kakaoSdkAvailable()).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});

describe('kakaoIdToken', () => {
  it('SDK를 네이티브 앱 키로 한 번만 준비하고 ID 토큰을 돌려줌', async () => {
    mockLogin.mockResolvedValue({ idToken: 'id-token' });
    await expect(kakaoIdToken()).resolves.toBe('id-token');
    await kakaoIdToken();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith('native-key');
  });

  it('동의 창을 닫으면(Cancelled) null', async () => {
    mockLogin.mockRejectedValue(Object.assign(new Error('user cancelled'), { code: 'Cancelled' }));
    await expect(kakaoIdToken()).resolves.toBeNull();
  });

  it('그 밖의 SDK 오류는 그대로 던짐', async () => {
    const error = Object.assign(new Error('KOE101'), { code: 'Misconfigured' });
    mockLogin.mockRejectedValue(error);
    await expect(kakaoIdToken()).rejects.toBe(error);
  });

  it('ID 토큰이 없으면(OpenID Connect 꺼짐) 해요체 UserError', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLogin.mockResolvedValue({});
    const error = await kakaoIdToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe('카카오 로그인 정보를 받지 못했어요. 잠시 뒤 다시 해 주세요');
    warn.mockRestore();
  });
});

describe('kakaoSdkLogout', () => {
  it('카카오 토큰이 없어 실패해도 던지지 않음', async () => {
    mockLogout.mockRejectedValue(Object.assign(new Error('no token'), { code: 'TokenNotFound' }));
    await expect(kakaoSdkLogout()).resolves.toBeUndefined();
  });

  it('SDK가 안 되는 빌드는 아무것도 안 부름', async () => {
    mockExtra.kakaoNativeAppKey = undefined;
    await kakaoSdkLogout();
    expect(mockLogout).not.toHaveBeenCalled();
  });
});
