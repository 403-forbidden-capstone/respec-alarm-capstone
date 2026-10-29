// 장소 검색 시트(PlaceSearchSheet)의 순수 함수 — 글자 만들기 · 기준점 고르기. 화면 없이 시험할 수 있게 부품에서 뺌
import type { LatLng, Place } from './types';

// 입력을 멈추고 이만큼 지나야 검색함 (타이핑마다 카카오를 부르지 않게)
export const SEARCH_DELAY_MS = 300;

// 카카오 category_name('교육,학문 > 대학교')은 큰 분류부터 이어져 있어 줄에는 마지막 칸만 — '>'가 없으면 그대로. 비면 ''
export function categoryLeaf(category?: string | null): string {
  const parts = (category ?? '').split('>').map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// 장소 줄 아래 글자 — '주소 · 분류'. 둘 다 없으면 '' (줄을 그리지 않음)
export function placeSubtitle(place: Pick<Place, 'address' | 'category'>): string {
  return [place.address?.trim(), categoryLeaf(place.category)].filter(Boolean).join(' · ');
}

// 결과가 없을 때 머리 글자 — 검색어를 따옴표로 감쌈
export function noResultTitle(query: string): string {
  return `'${query.trim()}' 검색 결과가 없어요`;
}

// 프로필의 집 좌표 → 검색 기준점. 위도 · 경도가 둘 다 숫자일 때만, 아니면 undefined (범위 검사는 listPlaces가 함)
export function homeOf(profile?: { home_lat?: number | null; home_lng?: number | null } | null): LatLng | undefined {
  const lat = profile?.home_lat;
  const lng = profile?.home_lng;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}
