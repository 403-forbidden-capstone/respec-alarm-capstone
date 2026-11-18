import { afterEach, describe, expect, it } from '@jest/globals';

// app.config.js — app.json 위에 덧씌우는 값 세 가지(빌드 종류 · google-services · 카카오 SDK 키)가 서로 지우지 않는지
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS 설정 파일
const appConfig = require('../../../app.config.js') as (ctx: { config: Record<string, unknown> }) => Record<string, any>;

const base = { name: 'Re:Spec Alarm', version: '1.0.0', plugins: ['expo-router'], extra: { eas: { projectId: 'p' } }, web: {} };
const saved = { variant: process.env.EXPO_PUBLIC_APP_VARIANT, kakao: process.env.KAKAO_NATIVE_APP_KEY };

afterEach(() => {
  process.env.EXPO_PUBLIC_APP_VARIANT = saved.variant;
  process.env.KAKAO_NATIVE_APP_KEY = saved.kakao;
  if (saved.variant === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
  if (saved.kakao === undefined) delete process.env.KAKAO_NATIVE_APP_KEY;
});

describe('app.config.js', () => {
  it('개발자용 빌드(변수 없음)는 이름 뒤 "개발" · 버전 0.1.0, 카카오 키가 있어도 그대로 (#503)', () => {
    delete process.env.EXPO_PUBLIC_APP_VARIANT;
    process.env.KAKAO_NATIVE_APP_KEY = 'native-key';
    const config = appConfig({ config: base });
    expect(config.name).toBe('Re:Spec Alarm 개발');
    expect(config.version).toBe('0.1.0');
    expect(config.extra.kakaoNativeAppKey).toBe('native-key');
    expect(config.extra.eas).toEqual({ projectId: 'p' });
    expect(config.plugins).toContainEqual([
      '@react-native-kakao/core',
      { nativeAppKey: 'native-key', android: { authCodeHandlerActivity: true }, ios: { handleKakaoOpenUrl: true } },
    ]);
  });

  it('실배포(release)는 app.json 이름 · 버전 그대로', () => {
    process.env.EXPO_PUBLIC_APP_VARIANT = 'release';
    const config = appConfig({ config: base });
    expect(config.name).toBe('Re:Spec Alarm');
    expect(config.version).toBe('1.0.0');
  });

  it('카카오 키가 없으면 플러그인 · extra 값을 안 넣음 (앱은 브라우저 로그인)', () => {
    delete process.env.KAKAO_NATIVE_APP_KEY;
    const config = appConfig({ config: base });
    expect(config.plugins).toEqual(['expo-router']);
    expect(config.extra.kakaoNativeAppKey).toBeUndefined();
  });
});
