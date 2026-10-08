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

// 가짜 데이터 모드의 내 프로필 — 목업의 '나', 기본값은 DB 기본값과 같음 (supabase/migrations init_schema profiles)
export const MOCK_PROFILE: Profile = {
  user_id: 'me',
  nickname: '나',
  handle: null,
  profile_image_url: null,
  default_prepare_minutes: 60,
  default_buffer_minutes: 10,
  home_name: '집',
  home_lat: null,
  home_lng: null,
  default_transport: 'TRANSIT',
  timezone: 'Asia/Seoul',
};

// 온보딩부터 다시 (개발용, /dev/screens) — 아이디 · 집을 비우고 기본값을 DB 기본값으로. 계정은 그대로
export async function resetOnboarding(userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .update({
      handle: null,
      home_name: null,
      home_lat: null,
      home_lng: null,
      default_prepare_minutes: 60,
      default_buffer_minutes: 10,
      default_transport: 'TRANSIT',
    })
    .eq('user_id', userId)
    .select('user_id');
  if (error) throw error;
  // RLS에 막히거나 다른 사용자면 오류 없이 0행 — 비운 줄 알고 넘어가지 않게
  if (!data?.length) throw new Error('내 프로필을 바꾸지 못했어요');
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
