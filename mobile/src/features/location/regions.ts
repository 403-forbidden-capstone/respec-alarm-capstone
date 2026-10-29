// 감시 목록 — 지금 등록해 둘 지오펜스 영역 (7.13.7 · D68 · D77 · D78)
//   · 집은 좌표가 있으면 늘 감시 (D68 집 상시), 반경 = home_radius_m → 없으면 200m
//   · 목적지 · 집 아닌 출발지는 감시 시간창(W_geo: 출발 예정 60분 전 ~ 약속 60분 후) 안에서만, 도착이 기록되면 뺌
//   · 출발지가 비었거나 집 반경 안이면 집에서 출발 — 따로 영역을 만들지 않고 집 이탈로 잡음
//   · 출발지 ~ 목적지 500m 안이면 목적지를 감시하지 않음 — 출발만 살림 (D78 기본안 A)
//   · 같은 좌표(소수 5자리)는 한 영역으로 합침, 반경은 큰 쪽. id = 좌표로 만든 짧은 고정 글자 → 다시 계획해도 같은 id
//     (등록 층은 바뀐 영역만 다시 등록 — 다시 등록하면 "이미 안" 신호가 또 옴)
//   · 상한 20개 — 집 먼저, 나머지는 쓰이는 시각(출발지 = 출발 예정, 목적지 = 약속) 이른 순
// 받는 쪽(expo-location 또는 Kotlin GeofencingClient)과 상관없는 순수 함수. 시각은 모두 ms
import { stableUuid } from '@/lib/uuid';

import {
  HOME_RADIUS_M,
  MAX_RADIUS_M,
  MAX_REGIONS,
  MIN_RADIUS_M,
  minutesMs,
  UNKNOWN_RADIUS_M,
  WINDOW_AFTER_APPOINTMENT_MINUTES,
  WINDOW_BEFORE_DEPART_MINUTES,
} from './constants';
import { distanceM, isNearTrip, toLatLng, type LatLng, type MaybeLatLng } from './geo';

export const HOME_REGION_ID = 'home';

// profiles.home_lat · home_lng · home_radius_m
export type HomeInput = (NonNullable<MaybeLatLng> & { radiusM?: number | null }) | null | undefined;
// appointments.dest_lat · dest_lng · dest_radius_m / appointment_participants.origin_lat · origin_lng
export type PlaceInput = NonNullable<MaybeLatLng> & { radiusM?: number | null };

export type ParticipantInput = {
  participantId: string;
  appointmentAt: number; // 약속 시각
  departAt: number; // 출발 예정 — 출발 알람 시각, 없으면 plannedDepartAt
  dest?: PlaceInput | null;
  origin?: PlaceInput | null; // 좌표가 비면 집
  departedAt?: number | null; // 이미 기록된 출발 (출처 무관)
  arrivedAt?: number | null; // 이미 기록된 도착
};

// 판정(attach · transitions)이 쓰는 참여 조건 — 계획 때 값. 좌표는 들고 있지 않음
export type TrackedParticipant = {
  participantId: string;
  appointmentAt: number;
  departAt: number;
  fromHome: boolean; // 집에서 출발 (출발지가 비었거나 집 반경 안)
  near: boolean; // 출발지 ~ 목적지 500m 안 — 도착 감지 · 이동시간 끔 (D78)
  departedAt: number | null;
  arrivedAt: number | null;
};

export type MonitoredRegion = {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
  home: boolean; // 집 — 이탈은 오늘 첫 약속에 붙임 (attach.ts, D79)
  originOf: string[]; // 여기서 출발하는 참여 조건 (집 아닌 출발지)
  destOf: string[]; // 여기가 목적지인 참여 조건
};

export type RegionPlan = { regions: MonitoredRegion[]; participants: TrackedParticipant[] };

export type PlanInput = {
  home?: HomeInput;
  participants: readonly ParticipantInput[];
  now: number;
  aheadMinutes?: number; // 창이 열리기 이만큼 전부터 미리 등록 (기본 0 = 창 안에서만)
};

// 출발 예정 = 약속 − 여유 − 이동 (서버 calc/chain.ts departureAuto와 같은 식) — 출발 알람 시각을 못 읽을 때
export function plannedDepartAt(input: { appointmentAt: number; travelMinutes: number | null; bufferMinutes: number }): number {
  return input.appointmentAt - minutesMs(input.bufferMinutes + (input.travelMinutes ?? 0));
}

// 감시 시간창 W_geo (7.13.7) — 양 끝 포함
export function detectionWindow(p: { departAt: number; appointmentAt: number }): { start: number; end: number } {
  return { start: p.departAt - minutesMs(WINDOW_BEFORE_DEPART_MINUTES), end: p.appointmentAt + minutesMs(WINDOW_AFTER_APPOINTMENT_MINUTES) };
}

// 칸 값(100~500) → 없거나 이상하면 기본값, 범위 밖이면 끝으로
export function radiusOr(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(value)));
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const regionIdOf = (p: LatLng) => `r${stableUuid('geo-region', p.lat.toFixed(5), p.lng.toFixed(5)).replace(/-/g, '').slice(0, 12)}`;

type Draft = MonitoredRegion & { firstAt: number };

const byTime = (a: ParticipantInput, b: ParticipantInput) =>
  a.appointmentAt - b.appointmentAt || a.departAt - b.departAt || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);

export function planRegions(input: PlanInput): RegionPlan {
  const homePoint = toLatLng(input.home);
  const homeRadius = radiusOr(input.home?.radiusM, HOME_RADIUS_M);
  const ahead = minutesMs(Math.max(0, input.aheadMinutes ?? 0));
  const drafts = new Map<string, Draft>();
  const participants: TrackedParticipant[] = [];

  const addUse = (point: LatLng, radiusM: number, role: 'originOf' | 'destOf', participantId: string, at: number) => {
    const center = { lat: round5(point.lat), lng: round5(point.lng) };
    const id = regionIdOf(center);
    const found = drafts.get(id);
    if (found) {
      found.radiusM = Math.max(found.radiusM, radiusM);
      found.firstAt = Math.min(found.firstAt, at);
      if (!found[role].includes(participantId)) found[role].push(participantId);
      return;
    }
    const region: Draft = { id, ...center, radiusM, home: false, originOf: [], destOf: [], firstAt: at };
    region[role].push(participantId);
    drafts.set(id, region);
  };

  for (const p of [...input.participants].sort(byTime)) {
    const origin = toLatLng(p.origin);
    const dest = toLatLng(p.dest);
    const fromHome = origin == null || (homePoint != null && distanceM(origin, homePoint) <= homeRadius);
    const start = fromHome ? homePoint : origin;
    const near = start != null && dest != null && isNearTrip(start, dest);
    const arrivedAt = p.arrivedAt ?? null;
    participants.push({ participantId: p.participantId, appointmentAt: p.appointmentAt, departAt: p.departAt, fromHome, near, departedAt: p.departedAt ?? null, arrivedAt });

    const span = detectionWindow(p);
    if (arrivedAt != null || input.now < span.start - ahead || input.now > span.end) continue;
    // 집 아닌 출발지 — 반경 칸이 없어 모르는 곳 기본값. 출발 뒤에도 도착 전까지 둠 (도착 전 귀가 = 출발 취소, D79)
    if (!fromHome && origin) addUse(origin, UNKNOWN_RADIUS_M, 'originOf', p.participantId, p.departAt);
    if (dest && !near) addUse(dest, radiusOr(p.dest?.radiusM, UNKNOWN_RADIUS_M), 'destOf', p.participantId, p.appointmentAt);
  }

  const others = [...drafts.values()]
    .sort((a, b) => a.firstAt - b.firstAt || (a.id < b.id ? -1 : 1))
    .map((d): MonitoredRegion => ({ id: d.id, lat: d.lat, lng: d.lng, radiusM: d.radiusM, home: false, originOf: d.originOf, destOf: d.destOf }));
  const home: MonitoredRegion[] = homePoint
    ? [{ id: HOME_REGION_ID, lat: round5(homePoint.lat), lng: round5(homePoint.lng), radiusM: homeRadius, home: true, originOf: [], destOf: [] }]
    : [];
  return { regions: [...home, ...others].slice(0, MAX_REGIONS), participants };
}

export type RegionDiff = { add: MonitoredRegion[]; remove: string[] };

const sameShape = (a: MonitoredRegion, b: MonitoredRegion) => a.lat === b.lat && a.lng === b.lng && a.radiusM === b.radiusM;

// 등록 바꿀 것 — id + 중심 + 반경으로 비교. 중심 · 반경이 바뀐 영역은 remove · add 둘 다 (지우고 다시 등록)
//   쓰는 참여 조건(originOf · destOf)만 바뀐 영역은 다시 등록하지 않음 — 계획만 새로 보관
export function diffRegions(prev: readonly MonitoredRegion[], next: readonly MonitoredRegion[]): RegionDiff {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const nextById = new Map(next.map((r) => [r.id, r]));
  const kept = (r: MonitoredRegion, other: Map<string, MonitoredRegion>) => {
    const found = other.get(r.id);
    return found != null && sameShape(r, found);
  };
  return {
    add: next.filter((r) => !kept(r, prevById)),
    remove: prev.filter((r) => !kept(r, nextById)).map((r) => r.id),
  };
}
