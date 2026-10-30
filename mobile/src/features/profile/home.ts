// L7 PR 3의 saveProfileFields가 들어오면 그쪽으로 합침
// 집 위치 저장 (H05 "집 위치를 몰라" 안내 카드의 [집 정하기]) — 데이터 접근은 profile/api.ts와 같은 방식
import { UserError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

export type HomeInput = { name: string; lat: number; lng: number };

// 순수 입력 검사 — 이름이 비지 않고, 위도 -90~90 · 경도 -180~180 인 유한한 숫자
export function homeInputOk(home: HomeInput): boolean {
  return (
    home.name.trim() !== '' &&
    Number.isFinite(home.lat) &&
    Number.isFinite(home.lng) &&
    home.lat >= -90 &&
    home.lat <= 90 &&
    home.lng >= -180 &&
    home.lng <= 180
  );
}

export async function saveHome(userId: string, home: HomeInput): Promise<void> {
  if (!homeInputOk(home)) throw new UserError('이 장소는 집으로 정할 수 없어요');
  const { data, error } = await supabase
    .from('profiles')
    .update({ home_name: home.name.trim(), home_lat: home.lat, home_lng: home.lng })
    .eq('user_id', userId)
    .select('user_id');
  if (error) throw error;
  // RLS에 막히거나 다른 사용자면 오류 없이 0행 — 저장한 줄 알고 넘어가지 않게
  if (!data?.length) throw new UserError('집 위치를 저장하지 못했어요');
}
