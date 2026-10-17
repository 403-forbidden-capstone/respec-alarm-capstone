import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import type { Database } from '@/types/database';

// 값은 mobile/.env (EXPO_PUBLIC_는 앱에 그대로 들어가는 공개 값) — 이름은 .env.example 참고
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

// 값이 없으면(웹 미리보기 · 프로젝트 연결 전) 로그인 없이 목업 데이터로 돎
export const isSupabaseConfigured = Boolean(url && key);

// 폰은 AsyncStorage에 세션 보관, 웹은 supabase-js 기본(localStorage)
const nativeStorage = Platform.OS === 'web' ? undefined : AsyncStorage;

// Database 타입(types/database.ts)을 붙여 칸 이름 오타 · 없는 테이블을 tsc가 잡게 함. 스키마를 바꾸면 이 파일도 같이 바꿈 (supabase/README.md)
export const supabase = createClient<Database>(url || 'https://placeholder.supabase.co', key || 'placeholder-key', {
  auth: {
    storage: nativeStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web', // 웹은 로그인 뒤 주소에 붙은 토큰을 바로 읽음
  },
});

// 폰에서는 앱이 앞에 있을 때만 토큰을 새로 고침
if (Platform.OS !== 'web' && isSupabaseConfigured) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
