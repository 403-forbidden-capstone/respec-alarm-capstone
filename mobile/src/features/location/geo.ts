// 거리 · 좌표 — 하버사인(구면 거리, m)
//   좌표는 폰 안에서만 씀. 서버 · 로그에는 시각 · 출처만 (7.13.7 저장 범위)
import { NEAR_TRIP_M } from './constants';

export type LatLng = { lat: number; lng: number };
// DB 칸 모양 (profiles.home_lat · appointments.dest_lat 등은 비어 있을 수 있음)
export type MaybeLatLng = { lat?: number | null; lng?: number | null } | null | undefined;

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 위도 · 경도가 둘 다 있고 범위 안일 때만 좌표
export function toLatLng(p: MaybeLatLng): LatLng | null {
  if (!p) return null;
  const { lat, lng } = p;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// 가까운 이동 — 도착 감지 · 실제 이동시간 끔 (D78 기본안 A)
export function isNearTrip(from: LatLng, to: LatLng): boolean {
  return distanceM(from, to) < NEAR_TRIP_M;
}
