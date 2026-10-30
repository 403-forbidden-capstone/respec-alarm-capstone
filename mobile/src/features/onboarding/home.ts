// 집 위치 단계(L02-4)의 순수 함수 — 고른 장소가 집으로 쓸 수 있는지 · 프로필에 쓸 값 (시험: __tests__/home.test.ts)
import type { Place } from '@/features/alarm/types';
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
