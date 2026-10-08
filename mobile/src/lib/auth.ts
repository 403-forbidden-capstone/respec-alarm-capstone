import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from './supabase';

// 웹 팝업의 결과를 원래 창에 넘기는 WebBrowser.maybeCompleteAuthSession()은 app/_layout.tsx에서 부름
// (화면이 열릴 때만 읽히는 모듈에 두면 /auth/callback으로 돌아온 팝업에서 실행되지 않을 수 있음)

export type OAuthProvider = 'kakao' | 'google';

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

// 카카오 · 구글 로그인 — 브라우저에서 동의 → 앱으로 돌아와 세션 저장
// 사용자가 창을 닫으면 null
export async function signInWithProvider(provider: OAuthProvider) {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: authRedirectUrl, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('로그인 주소를 받지 못했어요');

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

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// 저장된 로그인이 있는지 — 가짜 데이터 모드에서 실데이터로 바꿀 때 갈 곳(탭 · 로그인)을 정함 (useAuth는 가짜 모드에서 세션을 숨김)
export async function hasSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  return data.session != null;
}
