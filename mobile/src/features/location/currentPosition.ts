// 지금 위치 한 번 — 지도 고르기 시트의 [현재 위치] 버튼이 부름. 앞(앱 사용 중) 권한만 쓰고 백그라운드 권한은 건드리지 않음
//   · 저장하지 않음 (지도를 그 자리로 옮기는 데만 씀). 거절 · 실패 · 안드로이드가 아닌 곳(웹 · 시험)은 null
//   · 8초 안에 못 읽으면 5분 안의 마지막 위치로 대신하고, 그것도 없으면 null
import { Platform } from 'react-native';

import type { LatLng } from '@/features/alarm/types';

import { nativeLocation } from './native';

// 현재 위치를 이 안에 못 읽으면 마지막으로 알려진 위치로 대신함 (실내 · GPS 느림에서 버튼이 하염없이 도는 것을 막음)
export const LOCATE_TIMEOUT_MS = 8000;
// 마지막 위치는 이만큼(ms) 안의 것만 씀 — 너무 오래된 위치로 지도를 옮기지 않으려고
const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000;

const toLatLng = (position: { coords: { latitude: number; longitude: number } } | null): LatLng | null => {
  if (!position) return null;
  const { latitude, longitude } = position.coords;
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null;
};

// 시간 안에 안 끝나면 거절 — 타이머는 끝나면 풂
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function locateOnce(): Promise<LatLng | null> {
  if (Platform.OS !== 'android') return null; // 웹은 단순하게 건너뜀
  try {
    const Location = nativeLocation();
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    try {
      const here = toLatLng(await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), LOCATE_TIMEOUT_MS));
      if (here) return here;
    } catch {
      /* 시간 초과 · 위치 꺼짐 — 아래에서 마지막 위치로 */
    }
    return toLatLng(await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }));
  } catch {
    return null; // 권한 확인 실패 등 — 좌표 원문은 남기지 않음
  }
}
