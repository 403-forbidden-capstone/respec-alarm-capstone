// 푸시 토큰 — 로그인 · 앱 시작마다 서버에 등록하고, 로그아웃 때 이 기기의 토큰 행을 지움 (친구 논리설계 11장)
//   등록은 register_push_token으로만 (직접 insert · update는 서버가 막음 — 모양 검사 · 한 사람 10대 상한이 거기 있음). 같은 폰에서 계정이 바뀌면 토큰 주인이 마지막 로그인 계정으로 바뀜
//   채널이 없는 기기에는 알림이 안 보이므로 채널을 먼저 만든 다음에 토큰을 받음
//   안드로이드만 — 웹 · iOS는 아무 일도 안 함 (iOS 푸시는 2단계). 푸시는 덤이라 실패해도 던지지 않고 결과만 돌려줌
import { Platform } from 'react-native';

import { ensureNotificationChannels } from './channels';
import { supabase } from '@/lib/supabase';

export type PushRegistration = 'registered' | 'unsupported' | 'failed';

let current: string | null = null; // 이번 실행에서 등록한 토큰 — 로그아웃 때 같은 값을 지움

const warn = (what: string, e: unknown) => {
  if (__DEV__) console.warn(`[push] ${what}`, e);
};

// Expo 푸시 토큰 — EAS 프로젝트 id가 app.json에 있음. 폰에서 못 받으면 null
async function fetchToken(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 웹에서는 모듈을 읽지 않으려고 안드로이드일 때 여기서만 읽음
  const Notifications = require('expo-notifications') as typeof import('expo-notifications');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 위와 같음
  const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
  const eas = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas;
  const projectId = eas?.projectId ?? Constants.easConfig?.projectId;
  const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return data || null;
}

export async function registerPushToken(): Promise<PushRegistration> {
  if (Platform.OS !== 'android') return 'unsupported';
  try {
    await ensureNotificationChannels();
    const token = await fetchToken();
    if (!token) return 'failed';
    const { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: 'android' });
    if (error) throw error;
    current = token;
    return 'registered';
  } catch (e) {
    warn('토큰 등록 실패', e);
    return 'failed';
  }
}

// 로그아웃 때 — 세션이 있는 지금이어야 RLS(자기 행만 지우기)를 통과함. 등록한 적이 없으면 폰에서 다시 받아 지움
//   못 지워도 로그아웃은 계속 (부르는 쪽이 삼킴) — 다음 로그인이 같은 토큰을 새 주인으로 옮김
export async function removePushToken(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const token = current ?? (await fetchToken());
  current = null;
  if (!token) return;
  const { error } = await supabase.from('push_tokens').delete().eq('token', token);
  if (error) throw error;
}

// 시험용
export function resetPushToken() {
  current = null;
}
