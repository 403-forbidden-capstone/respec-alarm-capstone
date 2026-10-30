// 지금 위치 한 번 — 지도 고르기 시트의 [현재 위치] 버튼이 부름. 앞(앱 사용 중) 권한만 쓰고 백그라운드 권한은 건드리지 않음
//   · 저장하지 않음 (지도를 그 자리로 옮기는 데만 씀). 거절 · 실패 · 안드로이드가 아닌 곳(웹 · 시험)은 null
import { Platform } from 'react-native';

import type { LatLng } from '@/features/alarm/types';

import { nativeLocation } from './native';

export async function locateOnce(): Promise<LatLng | null> {
  if (Platform.OS !== 'android') return null; // 웹은 단순하게 건너뜀
  try {
    const Location = nativeLocation();
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const { latitude, longitude } = position.coords;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null;
  } catch {
    return null; // 위치 꺼짐 · 시간 초과 등 — 좌표 원문은 남기지 않음
  }
}
