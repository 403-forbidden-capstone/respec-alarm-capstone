// 내 프로필 — 데이터 접근은 이 파일에서만 함 (docs/screen-data-map.md 로그인 · 온보딩)
import { cleanHandle } from '@/features/onboarding/validate';
import { parseDbTime } from '@/lib/dbTime';
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

import type { HandleChange } from './handle';
import type { Profile, ProfileFields } from './types';

const COLUMNS =
  'user_id, nickname, handle, handle_changed_at, handle_next_change_at, profile_image_url, default_prepare_minutes, default_buffer_minutes, home_name, home_lat, home_lng, home_radius_m, default_transport, timezone, onboarded_at, wake_sensitivity, wake_margin, privacy_agreed_at, privacy_version, wake_ping_enabled, ml_age_years, ml_school_status, ml_work_status, ml_holiday_code, ml_profile_consented_at';

// 내 프로필 한 행 — 가입하면 DB 트리거가 만들어 둠
export async function getMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(COLUMNS).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

// 내 아이디 바꾸기 — change_my_handle(DB 함수)로만. 앱이 profiles에 직접 쓰면 막힘(42501, 친구 2장)
//   형식 · respec_ · 중복(TAKEN) · 30일 1번(LIMIT)은 서버가 판정 — 앱은 결과 상태를 문구로 보여 줌 (profile/handle.ts handleChangeMessage)
export async function changeMyHandle(input: string): Promise<HandleChange> {
  const { data, error } = await supabase.rpc('change_my_handle', { p_handle: cleanHandle(input) });
  if (error) throw error;
  const r = (data ?? {}) as { status?: string; handle?: string; next_change_at?: string | null; retry_after_seconds?: number };
  const next = r.next_change_at ? parseDbTime(r.next_change_at) : null;
  switch (r.status) {
    case 'OK':
      return { status: 'OK', handle: r.handle ?? '', nextChangeAt: next };
    case 'LIMIT':
      // 30일(next_change_at)과 검색 횟수(retry_after_seconds) 두 가지 — 바꾸기 시도도 검색과 같은 1분 10회 · 하루 100회에 셈
      if (next) return { status: 'LIMIT', nextChangeAt: next };
      if (typeof r.retry_after_seconds === 'number') return { status: 'BUSY', retryAfterSeconds: r.retry_after_seconds };
      throw new Error('LIMIT인데 다음 가능 시각이 없어요');
    case 'SAME':
    case 'INVALID':
    case 'RESERVED':
    case 'TAKEN':
      return { status: r.status };
    default:
      throw new Error(`알 수 없는 아이디 변경 상태: ${String(r.status)}`);
  }
}

// 가짜 데이터 모드의 내 프로필 — 목업의 '나', 기본값은 DB 기본값과 같음 (supabase/migrations init_schema profiles)
export const MOCK_PROFILE: Profile = {
  user_id: 'me',
  nickname: '나',
  handle: null,
  handle_changed_at: null,
  handle_next_change_at: null,
  profile_image_url: null,
  default_prepare_minutes: 60,
  default_buffer_minutes: 10,
  home_name: '집',
  home_lat: null,
  home_lng: null,
  home_radius_m: null,
  default_transport: 'TRANSIT',
  timezone: 'Asia/Seoul',
  // 가짜 모드는 온보딩을 거치지 않으므로 이미 끝낸 것으로 둠 (null이면 온보딩 판정에 걸림)
  onboarded_at: '2026-05-22T00:00:00+09:00',
  wake_sensitivity: 'NORMAL',
  wake_margin: 'NORMAL',
  privacy_agreed_at: null,
  privacy_version: null,
  wake_ping_enabled: true,
  ml_age_years: null,
  ml_school_status: null,
  ml_work_status: null,
  ml_holiday_code: null,
  ml_profile_consented_at: null,
};

// 온보딩부터 다시 (개발용, /dev/screens) — 내 시험 데이터를 지우고 프로필을 온보딩 전으로 되돌림. 계정은 그대로
//   아이디 · 온보딩 칸은 앱이 직접 못 쓰므로(친구 2장) DB 함수 dev_reset_my_data가 함. 부른 사람 본인 줄만 건드림
export async function resetOnboarding(userId: string): Promise<void> {
  void userId; // 함수가 auth.uid()로 본인을 정함 — 인자는 부르는 쪽 모양을 그대로 두려고 받기만 함
  const { error } = await supabase.rpc('dev_reset_my_data');
  if (error) throw error;
}

// 내 프로필 한 행 갱신 — 갱신된 행을 돌려받음
async function updateMyProfile(userId: string, values: ProfileFields & { onboarded_at?: string }): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').update(values).eq('user_id', userId).select(COLUMNS);
  if (error) throw error;
  // RLS에 막히거나 다른 사용자면 오류 없이 0행 — 저장한 줄 알고 넘어가지 않게
  const row = (data as Profile[] | null)?.[0];
  if (!row) throw new UserError('내 프로필을 바꾸지 못했어요');
  return row;
}

// 내 프로필 칸 일부만 저장 — 온보딩 단계마다 · 설정에서 씀. 아이디는 changeMyHandle
export function saveProfileFields(userId: string, fields: ProfileFields): Promise<Profile> {
  return updateMyProfile(userId, fields);
}

// 온보딩 끝 — 끝낸 시각만 적음. 이 값이 있어야 온보딩 판정(features/auth/onboardingGate.ts)이 풀림
export function finishOnboarding(userId: string): Promise<Profile> {
  return updateMyProfile(userId, { onboarded_at: new Date().toISOString() });
}
