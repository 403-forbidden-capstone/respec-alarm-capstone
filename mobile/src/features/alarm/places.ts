// 장소 — place-search 결과(서버 모양)를 화면 Place로 바꾸고, 이름 → 좌표를 기억해 둠 (실데이터)
//   H05 · H03 장소 칸은 이름 글자만 들고 있어서(SelectRow), 고른 이름으로 좌표를 다시 찾을 수 있게 목록을 읽을 때마다 기억함
//   카카오 응답은 저장 · 재사용이 안 되므로(D5) 이 기억은 메모리에만 두고, 앱을 다시 열면 사라짐 (DB에는 약속을 저장할 때 dest_lat · dest_lng로 남음)
import type { LatLng, Place } from './types';

export type PlaceDto = { id?: string; name: string; address?: string | null; lat?: number | string | null; lng?: number | string | null; category?: string | null };

const finite = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// 좌표는 위도 · 경도가 둘 다 있을 때만 (서버도 둘이 같이 있어야 받음)
export function toPlace(dto: PlaceDto): Place {
  const lat = finite(dto.lat);
  const lng = finite(dto.lng);
  return {
    name: dto.name,
    ...(dto.address ? { address: dto.address } : {}),
    ...(lat != null && lng != null ? { lat, lng } : {}),
    ...(dto.category ? { category: dto.category } : {}), // 서버 값 그대로 — 화면에 쓰기만 하고 저장하지 않음 (D5)
  };
}

// 기준점은 위도 · 경도가 둘 다 숫자일 때만 씀 (서버 place-search도 lat · lng가 같이 있어야 받음)
export function validNear(near?: LatLng): LatLng | undefined {
  return near && Number.isFinite(near.lat) && Number.isFinite(near.lng) ? { lat: near.lat, lng: near.lng } : undefined;
}

// 두 점 사이 직선거리(m) — 가까운 순 정렬용이라 지구를 구로 본 근사면 충분
export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, '');

// 가짜 장소 검색 — 이름 · 주소에 검색어가 들어간 곳만(대소문자 · 공백 무시), near가 있으면 가까운 순(직선거리). 좌표 없는 곳은 맨 뒤
//   실데이터는 서버(place-search)가 같은 일을 함
export function filterPlaces(list: readonly Place[], query: string, near?: LatLng): Place[] {
  const key = squash(query);
  const found = list.filter((p) => squash(p.name).includes(key) || squash(p.address ?? '').includes(key));
  const from = validNear(near);
  if (!from) return found;
  const dist = (p: Place) => (p.lat != null && p.lng != null ? distanceMeters(from, { lat: p.lat, lng: p.lng }) : Infinity);
  return found
    .map((p, i) => ({ p, i, d: dist(p) }))
    .sort((x, y) => (x.d === y.d ? x.i - y.i : x.d - y.d))
    .map((x) => x.p);
}

// 같은 이름은 먼저 나온 것만 (화면 칸이 이름을 키로 씀)
export function uniqueByName(places: readonly Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}

const known = new Map<string, Place>();

export function rememberPlaces(places: readonly Place[]): void {
  for (const p of places) if (p.lat != null && p.lng != null) known.set(p.name, p);
}

// 이름으로 좌표를 찾음 — 없으면 undefined (서버가 좌표 없이 직접 입력으로 이어 감)
export function lookupPlace(name: string): Place | undefined {
  return known.get(name);
}

export function forgetPlaces(): void {
  known.clear();
}

export type Point = { name: string; lat?: number; lng?: number };

// 요청 본문에 담을 장소 — 좌표가 있으면 같이
export function toPoint(name: string, coords?: { lat?: number; lng?: number }): Point {
  const found = coords?.lat != null && coords.lng != null ? coords : lookupPlace(name);
  return found?.lat != null && found.lng != null ? { name, lat: found.lat, lng: found.lng } : { name };
}
