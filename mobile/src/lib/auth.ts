import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { UserError } from './errors';
import { kakaoIdToken, kakaoSdkAvailable, kakaoSdkLogout } from './kakaoSdk';
import { supabase } from './supabase';

// 웹 팝업의 결과를 원래 창에 넘기는 WebBrowser.maybeCompleteAuthSession()은 app/_layout.tsx에서 부름
// (화면이 열릴 때만 읽히는 모듈에 두면 /auth/callback으로 돌아온 팝업에서 실행되지 않을 수 있음)

export type OAuthProvider = 'kakao' | 'google';
export type { Session };

// 로그인 뒤 돌아올 주소 — 앱은 respecalarm://auth/callback, 웹은 지금 사이트의 /auth/callback
// Supabase 대시보드 → Authentication → URL Configuration의 Redirect URLs에 등록해야 함
export const authRedirectUrl = Linking.createURL('auth/callback');

// 돌아온 주소의 # 또는 ? 뒤에서 토큰 · 오류를 꺼냄
function readTokens(url: string) {
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const raw = hashIndex >= 0 ? url.slice(hashIndex + 1) : queryIndex >= 0 ? url.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(raw);
  return {
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
    error: params.get('error_description') ?? params.get('error'),
  };
}

// 카카오 · 구글 로그인 — 사용자가 창을 닫으면 null
//   카카오: 키가 든 폰 빌드는 카카오 SDK(카카오톡 앱) → ID 토큰을 Supabase에 넘김 (lib/kakaoSdk). 웹 · 키 없는 빌드는 아래 브라우저 방식
//   구글: 브라우저에서 동의 → 앱으로 돌아와 세션 저장
export async function signInWithProvider(provider: OAuthProvider) {
  if (provider === 'kakao' && kakaoSdkAvailable()) return signInWithKakaoSdk();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: authRedirectUrl, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new UserError('로그인 주소를 받지 못했어요');

  const result = await WebBrowser.openAuthSessionAsync(data.url, authRedirectUrl);
  if (result.type !== 'success') return null;

  const { accessToken, refreshToken, error: oauthError } = readTokens(result.url);
  if (oauthError) throw new Error(oauthError);
  if (!accessToken || !refreshToken) return null;

  const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (sessionError) throw sessionError;
  return sessionData.session;
}

// 카카오 SDK 로그인 — 브라우저를 안 거쳐 supabase.co 주소가 안 보임. 같은 카카오 앱이라 브라우저로 가입한 사람도 같은 계정으로 들어옴(카카오 회원번호가 같음)
//   Supabase 대시보드 → Authentication → Providers → Kakao의 REST API Key 칸에 "REST 키,네이티브 앱 키"를 쉼표로 같이 넣어야 함
//   (웹 로그인은 첫 값을 쓰고, 이 ID 토큰은 네이티브 앱 키로 발급돼서 두 번째 값이 있어야 통과)
async function signInWithKakaoSdk() {
  const idToken = await kakaoIdToken();
  if (!idToken) return null;
  const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'kakao', token: idToken });
  if (error) {
    if (__DEV__) console.warn('[kakao] Supabase가 ID 토큰을 받지 않음:', error.message);
    throw error;
  }
  return data.session;
}

// 개발 메뉴(/dev/screens)의 이메일 로그인 — 시드 계정(supabase/seed)으로 카카오 · 구글 없이 들어갈 때 (웹 · 폰 개발용, lib/modePolicy.ts showDevLogin)
// 비밀번호는 코드에 적지 않고 입력 칸에서만 받음. Supabase Auth Providers에서 이메일 로그인이 켜져 있어야 함
export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    if (error.code === 'invalid_credentials') throw new UserError('이메일이나 비밀번호가 맞지 않아요');
    if (error.code === 'email_provider_disabled') throw new UserError('이메일 로그인이 꺼져 있어요. Supabase Auth Providers에서 켜 주세요');
    throw error;
  }
  return data.session;
}

// 낮은 층 로그아웃 — 화면에서는 lib/session의 signOutAndCleanup을 부를 것 (폰 알람 · 기록 정리가 먼저)
//   supabase-js는 서버에 로그아웃을 알리다 네트워크로 실패해도 이 기기의 로그인은 이미 지운 뒤 오류를 돌려줌 —
//   그대로 던지면 "로그아웃하지 못했어요"가 뜨는데 실제로는 로그아웃돼 로그인 화면으로 넘어감. 이 기기에 로그인이 남았을 때만 오류로 봄
//   (서버의 로그인 정보는 못 지웠을 수 있지만 이 기기에서는 쓸 수 없음)
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error && (await hasSession())) throw new UserError('로그아웃하지 못했어요. 다시 해 주세요');
  await kakaoSdkLogout(); // 이 폰에 남은 카카오 토큰 정리 — 실패해도 던지지 않음
}

// 저장된 로그인(세션)을 읽음 — 앱을 열 때 AuthProvider가 부름
export async function loadSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// 로그인 · 로그아웃 · 토큰 갱신을 알려 줌 — 돌려준 함수를 부르면 그만 들음
export function watchSession(onChange: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, next) => onChange(next));
  return () => data.subscription.unsubscribe();
}

// 저장된 로그인이 있는지 — 가짜 데이터 모드에서 실데이터로 바꿀 때 갈 곳(탭 · 로그인)을 정함 (useAuth는 가짜 모드에서 세션을 숨김)
export async function hasSession(): Promise<boolean> {
  return (await loadSession()) != null;
}
