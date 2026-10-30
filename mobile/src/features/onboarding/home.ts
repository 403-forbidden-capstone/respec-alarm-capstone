// 집 위치 단계(L02-4)의 순수 함수 — 고른 장소가 집으로 쓸 수 있는지 · 프로필에 쓸 값 (시험: __tests__/home.test.ts)
import type { Place } from '@/features/alarm/types';
import { homeOf } from '@/features/alarm/placeSheet';
import type { ProfileFields } from '@/features/profile/types';

const validLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

// 고른 장소 → 프로필에 저장할 집 값. 좌표(위도 · 경도 숫자)가 없는 장소는 null — 서버가 출발지 '집' 좌표를 프로필에서 채우기 때문 (_shared/plan-core.ts)
// 0은 유효한 좌표라 없는 것으로 보지 않음
export function homePatchOf(place: Pick<Place, 'name' | 'lat' | 'lng'>): ProfileFields | null {
  const name = place.name.trim();
  if (!name || !validLat(place.lat) || !validLng(place.lng)) return null;
  return { home_name: name, home_lat: place.lat, home_lng: place.lng };
}

// 출발지 '집'의 좌표를 서버가 프로필에서 채우므로, 이미 저장한 집 좌표가 있는지 — 이 단계에서 저장을 마친 집(homeSaved) 또는 프로필에 있던 집
// 수업 시간표 단계가 이동시간을 구할 수 있는지 판단하는 데 씀
export function hasHome(homeSaved: boolean, profile?: { home_lat?: number | null; home_lng?: number | null } | null): boolean {
  return homeSaved || homeOf(profile) != null;
}
