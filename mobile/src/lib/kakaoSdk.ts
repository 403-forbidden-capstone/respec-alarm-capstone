import Constants from 'expo-constants';
import { Platform, TurboModuleRegistry } from 'react-native';

import { UserError } from './errors';

// 카카오 SDK 로그인 — 브라우저(supabase.co 주소) 없이 카카오톡 앱으로 바로 동의 → ID 토큰을 Supabase에 넘김 (lib/auth가 부름)
//   키: 빌드 환경 변수 KAKAO_NATIVE_APP_KEY → app.config.js가 extra.kakaoNativeAppKey와 카카오 설정 플러그인에 넣음
//   키가 없는 빌드 · 카카오 네이티브 모듈이 없는 옛 개발 빌드 · 웹은 여기를 안 쓰고 브라우저 로그인 그대로
//   카카오톡이 없는 폰은 SDK가 알아서 카카오 계정 로그인 창(kauth.kakao.com)을 띄움

function appKey(): string | undefined {
  const value = (Constants.expoConfig?.extra as { kakaoNativeAppKey?: unknown } | undefined)?.kakaoNativeAppKey;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// 네이티브 모듈이라 쓸 때만 불러옴 — 맨 위에서 불러오면 모듈이 없는 옛 개발 빌드와 jest에서 불러오는 순간 던짐 (features/location/native와 같은 방식)
function sdk() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- kakaoSdkAvailable()이 참일 때만 읽음
    core: require('@react-native-kakao/core') as typeof import('@react-native-kakao/core'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- kakaoSdkAvailable()이 참일 때만 읽음
    user: require('@react-native-kakao/user') as typeof import('@react-native-kakao/user'),
  };
}

// 이 빌드에서 카카오 SDK로 로그인할 수 있는지
export function kakaoSdkAvailable(): boolean {
  if (Platform.OS === 'web' || !appKey()) return false;
  return TurboModuleRegistry.get('RNCKakaoCore') != null && TurboModuleRegistry.get('RNCKakaoUser') != null;
}

let initialized: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  const key = appKey();
  if (!key) return Promise.reject(new Error('KAKAO_NATIVE_APP_KEY가 빌드에 없음'));
  initialized ??= sdk()
    .core.initializeKakaoSDK(key)
    .catch((e: unknown) => {
      initialized = null; // 다음에 다시 시도
      throw e;
    });
  return initialized;
}

// 사용자가 동의 창을 닫음 — SDK가 ClientError Cancelled를 코드로 넘김
function isCancelled(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { code?: unknown }).code === 'Cancelled';
}

// 카카오 동의 → ID 토큰. 사용자가 닫으면 null
//   ID 토큰은 카카오 디벨로퍼스의 OpenID Connect가 켜져 있어야 옴
export async function kakaoIdToken(): Promise<string | null> {
  await ensureInitialized();
  let token: Awaited<ReturnType<ReturnType<typeof sdk>['user']['login']>>;
  try {
    token = await sdk().user.login();
  } catch (e) {
    if (isCancelled(e)) return null;
    throw e;
  }
  if (!token.idToken) {
    if (__DEV__) console.warn('[kakao] ID 토큰이 없음 — 카카오 디벨로퍼스 → 카카오 로그인 → OpenID Connect 켜기');
    throw new UserError('카카오 로그인 정보를 받지 못했어요. 잠시 뒤 다시 해 주세요');
  }
  return token.idToken;
}

// 로그아웃 때 이 폰에 남은 카카오 토큰도 지움 — 실패해도 우리 앱 로그아웃에는 영향 없음 (브라우저로 로그인했던 사람은 토큰이 없어 그냥 끝남)
export async function kakaoSdkLogout(): Promise<void> {
  if (!kakaoSdkAvailable()) return;
  try {
    await ensureInitialized();
    await sdk().user.logout();
  } catch {
    // 카카오 토큰이 없거나 네트워크 실패 — 무시
  }
}
