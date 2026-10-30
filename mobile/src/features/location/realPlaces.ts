// 자주 가는 곳 — 실데이터 (Supabase 표 user_places). 화면은 api.ts를 거침
//   본인 행만 보이고 쓸 수 있음 (RLS) — 그래도 user_id로 한 번 더 좁힘. 위치는 공유하지 않음 (Q13 · D59), 좌표는 로그에 남기지 않음
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import {
  fromRow,
  normalizeInput,
  placeError,
  toRow,
  USER_PLACE_COLUMNS,
  type UserPlace,
  type UserPlaceInput,
  type UserPlaceRow,
} from './userPlaces';

// 만든 순서대로 (칩 · 설정 줄 순서가 바뀌지 않게 같은 시각이면 이름표 순)
export async function listUserPlaces(): Promise<UserPlace[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('user_places').select(USER_PLACE_COLUMNS).eq('user_id', userId).order('created_at').order('label');
  if (error) throw error;
  return ((data ?? []) as UserPlaceRow[]).map(fromRow);
}

// 같은 이름표가 있으면 덮어씀 (user_id, label이 유일). 6번째 새 이름표는 DB 트리거가 54000으로 막음 → 이유 문구
export async function saveUserPlace(input: UserPlaceInput): Promise<UserPlace> {
  const place = normalizeInput(input);
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('user_places')
    .upsert(toRow(userId, place), { onConflict: 'user_id,label' })
    .select(USER_PLACE_COLUMNS)
    .single();
  if (error) throw placeError(error);
  return fromRow(data as UserPlaceRow);
}

// 없는 이름표를 지워도 오류 없이 끝남
export async function deleteUserPlace(label: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('user_places').delete().eq('user_id', userId).eq('label', label);
  if (error) throw error;
}
