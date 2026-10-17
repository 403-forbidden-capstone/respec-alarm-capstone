// 이동시간 폴백의 계산 부분 — 상세설계서 7장 7.1.2 (순서는 _shared/route.ts가 정함)
//   1 카카오 길찾기(API)  2 같은 경로 실측 이동시간 3건 이상 → 중앙값(CACHED)  3 좌표 직선거리 근사값  4 직접 입력(MANUAL)
//   카카오맵 API 응답은 저장 · 재사용할 수 없으므로(2026-09-01 카카오 답변) 2단계는 "내 실제 출발 · 도착 기록"만 씀.
//   중앙값은 계산해서 보여 주기만 하고 travel_source = CACHED로 쓰지 않음 (D5 열림)
import { MINUTE_MS } from './time.ts';
import type { Transport } from './types.ts';

export type LatLng = { lat: number; lng: number };

export const SAME_ROUTE_RADIUS_METERS = 300; // 같은 출발지 · 목적지로 보는 반경
export const SAME_ROUTE_MIN_SAMPLES = 3;
export const DETOUR_FACTOR = 1.3; // 직선거리 → 도로거리 우회 계수
// 이동 수단별 평균 속도 (km/h). BUS · SUBWAY는 대중교통과 같게
export const AVERAGE_SPEED_KMH: Record<Transport, number> = { WALK: 4, TRANSIT: 22, BUS: 22, SUBWAY: 22, CAR: 30 };

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 근사식: haversine 거리(km) ÷ 속도 × 60 × 우회 계수 1.3. 사용자 확인 없이 저장하지 않음
export function estimateTravelMinutes(from: LatLng, to: LatLng, transport: Transport): number {
  const minutes = (haversineKm(from, to) / AVERAGE_SPEED_KMH[transport]) * 60 * DETOUR_FACTOR;
  return Math.max(1, Math.round(minutes));
}

// 내 지난 이동 기록 한 줄 (출발 · 도착이 모두 찍힌 것)
export type TravelSample = {
  origin: LatLng;
  destination: LatLng;
  transport: Transport;
  departedAt: Date;
  arrivedAt: Date;
};

// 같은 출발지(300m) · 목적지(300m) · 이동 수단의 실측 이동시간(도착 − 출발) 3건 이상이면 중앙값
//   1분 미만 · 5시간 초과는 기록 오류로 보고 뺌
export function medianSameRoute(
  samples: readonly TravelSample[],
  origin: LatLng,
  destination: LatLng,
  transport: Transport,
): { minutes: number; sampleCount: number } | null {
  const radiusKm = SAME_ROUTE_RADIUS_METERS / 1000;
  const minutes = samples
    .filter(
      (s) =>
        s.transport === transport &&
        haversineKm(s.origin, origin) <= radiusKm &&
        haversineKm(s.destination, destination) <= radiusKm,
    )
    .map((s) => (s.arrivedAt.getTime() - s.departedAt.getTime()) / MINUTE_MS)
    .filter((m) => m >= 1 && m <= 300)
    .sort((a, b) => a - b);
  if (minutes.length < SAME_ROUTE_MIN_SAMPLES) return null;
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  return { minutes: Math.max(1, Math.round(median)), sampleCount: minutes.length };
}
