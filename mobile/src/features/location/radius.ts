// 감지 범위(반경) 고르기의 순수 함수 — 지도 고르기 시트의 "감지 범위 작게 · 보통 · 크게" (features/alarm/components/RadiusPicker)
//   반경 숫자 범위·기본값은 constants.ts · area.ts 그대로. 저장 칸: 집 profiles.home_radius_m · 자주 가는 곳 user_places.radius_m (모두 100~500m)
import { defaultRadiusFor } from './area';
import { MAX_RADIUS_M, MIN_RADIUS_M, UNKNOWN_RADIUS_M } from './constants';

// 프리셋 칸 이름 — 프리셋 3개를 작은 것부터 부름. 3개가 아니면 숫자(m)로 보임
export const RADIUS_PRESET_NAMES = ['작게', '보통', '크게'] as const;

// 목적지 기준 프리셋 (건물 150 · 대형 시설 300 기본값을 가운데·끝에 둠). 집은 부르는 쪽이 [100, 200, 300]을 넘김
export const DESTINATION_RADIUS_PRESETS: readonly number[] = [100, 150, 300];
export const HOME_RADIUS_PRESETS: readonly number[] = [100, 200, 300];

// 처음 값이 프리셋과 이 거리(m) 안이면 그 프리셋으로 붙임 — 아니면 저장된 사용자 지정 값을 그대로 둠 (건드리지 않았는데 값이 바뀌지 않게)
export const PRESET_SNAP_M = 25;

// 100~500m으로 맞춤 (소수는 반올림). 숫자가 아니면 분류를 모를 때 값(200)
export function clampRadius(meters: number): number {
  if (!Number.isFinite(meters)) return UNKNOWN_RADIUS_M;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(meters)));
}

// value에 가장 가까운 프리셋. within을 주면 그 거리(m) 안일 때만, 아니면 null. 똑같이 가까우면 작은 쪽. 프리셋이 비었으면 null
export function nearestPreset(value: number, presets: readonly number[], within = Infinity): number | null {
  if (!Number.isFinite(value)) return null;
  let best: number | null = null;
  for (const p of presets) {
    const gap = Math.abs(p - value);
    if (gap > within) continue;
    if (best == null || gap < Math.abs(best - value) || (gap === Math.abs(best - value) && p < best)) best = p;
  }
  return best;
}

// 시트를 열 때의 선택값 — 프리셋 가까이(25m 안)면 그 프리셋, 아니면 저장돼 있던 값 그대로(범위만 맞춤)
export function initialRadius(initial: number, presets: readonly number[]): number {
  return nearestPreset(initial, presets, PRESET_SNAP_M) ?? clampRadius(initial);
}

// 검색 결과를 눌렀을 때의 선택값 — 사용자가 이미 직접 골랐으면(touched) 그대로, 아니면 그 장소 분류의 기본 반경(area.defaultRadiusFor)에 가장 가까운 프리셋.
//   follow가 false면(집: 건물 분류와 상관없이 집 기본값) 그대로
export function radiusAfterPick({
  current,
  touched,
  follow = true,
  place,
  presets,
}: {
  current: number;
  touched: boolean;
  follow?: boolean;
  place: { name: string; category?: string | null };
  presets: readonly number[];
}): number {
  if (touched || !follow) return current;
  const wanted = defaultRadiusFor(place.category, place.name);
  return nearestPreset(wanted, presets) ?? clampRadius(wanted);
}

// 프리셋 칸에 붙일 이름 — 3개면 작게 · 보통 · 크게, 아니면 없음(숫자만)
export function presetName(index: number, count: number): string | null {
  return count === RADIUS_PRESET_NAMES.length ? RADIUS_PRESET_NAMES[index] : null;
}
