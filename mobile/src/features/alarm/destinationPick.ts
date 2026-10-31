// 새 일정(H05) 장소 줄의 순수 함수 — 지도 시트 · 자주 가는 곳 칩이 고른 장소를 초안에 담는 규칙. 화면 없이 시험할 수 있게 뺌
//   장소는 늘 이름 · 좌표 · 감지 반경(destRadiusM)을 한 묶음으로 바꿈 — 장소만 바뀌고 옛 반경이 남지 않게
import { MAX_RADIUS_M, MIN_RADIUS_M } from '@/features/location/constants';
import type { UserPlace } from '@/features/location/userPlaces';

import type { AppointmentDraft } from './types';

// 서버(appointment.destination.radius_m)가 받는 정수 100~500만 — 그 밖이면 없는 것으로 보고 보내지 않음 (서버 기본값을 씀)
export function validDestRadius(meters: number | null | undefined): number | undefined {
  if (meters == null || !Number.isFinite(meters)) return undefined;
  const rounded = Math.round(meters);
  return rounded >= MIN_RADIUS_M && rounded <= MAX_RADIUS_M ? rounded : undefined;
}

type PlaceSlice = Pick<AppointmentDraft, 'place' | 'placeLat' | 'placeLng' | 'destRadiusM'>;

// 시트에서 고른 장소(또는 칩)를 초안에 담음 — 반경이 없는 장소는 옛 반경을 지움
export function withDestination<T extends PlaceSlice>(draft: T, picked: { name: string; lat?: number; lng?: number; radiusM?: number }): T {
  const { destRadiusM: _old, ...rest } = draft;
  const radius = validDestRadius(picked.radiusM);
  return { ...rest, place: picked.name, placeLat: picked.lat, placeLng: picked.lng, ...(radius != null ? { destRadiusM: radius } : {}) } as T;
}

// 자주 가는 곳 칩을 눌렀을 때 — 시트가 고른 것과 같은 모양으로 바꿔 같은 규칙으로 담음
export function withUserPlace<T extends PlaceSlice>(draft: T, place: UserPlace): T {
  return withDestination(draft, { name: place.name, lat: place.lat, lng: place.lng, radiusM: place.radiusM });
}

// 지금 장소 칸이 어느 자주 가는 곳인지 (칩을 켬) — 이름과 좌표가 둘 다 같을 때만
export function selectedUserPlaceLabel(draft: Pick<AppointmentDraft, 'place' | 'placeLat' | 'placeLng'>, places: readonly UserPlace[] | undefined): string | undefined {
  if (!draft.place || draft.placeLat == null || draft.placeLng == null) return undefined;
  return places?.find((p) => p.name === draft.place && p.lat === draft.placeLat && p.lng === draft.placeLng)?.label;
}
