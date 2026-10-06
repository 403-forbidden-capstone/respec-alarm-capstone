// 내 프로필 — 데이터 접근은 이 파일에서만 함 (docs/screen-data-map.md 로그인 · 온보딩)
import { supabase } from '@/lib/supabase';

import type { OnboardingInput, Profile } from './types';

const COLUMNS =
  'user_id, nickname, handle, profile_image_url, default_prepare_minutes, default_buffer_minutes, home_name, home_lat, home_lng, default_transport, timezone';

// 내 프로필 한 행 — 가입하면 DB 트리거가 만들어 둠
export async function getMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(COLUMNS).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

// 아이디가 이미 쓰이는지 — 남의 프로필은 공개 칸만 주는 DB 함수로 확인
export async function isHandleTaken(handle: string, myUserId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('find_profile_by_handle', { p_handle: handle });
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as { user_id?: string }[];
  return rows.some((row) => row.user_id !== myUserId);
}

// 온보딩 저장 — 아이디 중복이면 DB 유일 제약(23505)이 막음
export async function saveOnboarding(userId: string, input: OnboardingInput): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ ...input, handle: input.handle?.toLowerCase() ?? null })
    .eq('user_id', userId)
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('이미 쓰는 아이디예요');
    throw error;
  }
  return data as Profile;
}
