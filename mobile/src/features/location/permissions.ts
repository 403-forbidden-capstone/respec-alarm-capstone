// 위치 권한 2단계 + 자동 기록 스위치 — 설정 카드(components/LocationAutoCard)와 L7의 온보딩 · 홈 안내가 부름
//   · 안드로이드 11+는 "항상 허용"을 시스템 창으로 못 받음 → 앱 사용 중 권한만 창으로 묻고, 항상 허용은 앱 설정 화면으로 보냄 (openLocationSettings)
//   · 안드로이드 12+에서 "대략적 위치"만 허용하면 지오펜스가 안 울림 → 따로 'coarse'로 알림
//   · 안드로이드 + 실데이터가 아니면 'unsupported' (expo-location을 읽지 않음)
//   함수 이름 · 모양은 다른 레인(L7)이 부르기로 약속한 것 — 바꾸지 말 것
import { Linking, Platform } from 'react-native';

import { isMock } from '@/lib/mode';

import { errorText, nativeLocation } from './native';
import { stopGeofences, syncLocation } from './register';
import { setLocationAuto as saveLocationAuto } from './store';

// off = 꺼짐(앞 권한 없음) · foreground-only = 앱 사용 중에만(항상 허용 아님) · coarse = 정확한 위치 꺼짐(대략적 위치만)
// on = 켜짐(항상 허용 + 정확한 위치) · unsupported = 웹 · 가짜 데이터 · 안드로이드 아님
export type LocationStatus = 'off' | 'foreground-only' | 'coarse' | 'on' | 'unsupported';

export type PermissionFacts = { foreground: boolean; background: boolean; accuracy?: 'fine' | 'coarse' | 'none' };

// 권한 값 → 상태. 앞 권한이 없으면 꺼짐 → 대략적 위치만이면 정확한 위치 꺼짐 → 항상 허용이 아니면 앱 사용 중에만 → 켜짐
//   정확도를 모르면(응답에 android 칸이 없음) 정확한 위치로 봄
export function statusOf({ foreground, background, accuracy }: PermissionFacts): LocationStatus {
  if (!foreground) return 'off';
  if (accuracy === 'coarse') return 'coarse';
  if (!background) return 'foreground-only';
  return 'on';
}

// 이 기기에서 위치 권한을 다룰 수 있는지 — 안드로이드 + 실데이터
const supported = () => Platform.OS === 'android' && !isMock();

// 지금 위치 권한 상태. 던지지 않음 (읽지 못하면 'off')
export async function getLocationStatus(): Promise<LocationStatus> {
  if (!supported()) return 'unsupported';
  try {
    const { getForegroundPermissionsAsync, getBackgroundPermissionsAsync } = nativeLocation();
    const [foreground, background] = await Promise.all([getForegroundPermissionsAsync(), getBackgroundPermissionsAsync()]);
    return statusOf({ foreground: foreground.granted, background: background.granted, accuracy: foreground.android?.accuracy });
  } catch (e) {
    if (__DEV__) console.warn('[location] 위치 권한을 읽지 못함', errorText(e));
    return 'off';
  }
}

// 앱 사용 중 권한을 시스템 창으로 요청. 받았으면 거기서 끝 — 항상 허용(background)은 현재 상태 그대로 읽어 돌려줌
//   항상 허용 요청은 여기서 안 함: 부르는 쪽이 openLocationSettings로 앱 설정 화면에 보냄. "다시 묻지 않음"이면 창이 안 떠서 foreground false
export async function requestLocationAccess(): Promise<{ foreground: boolean; background: boolean }> {
  if (!supported()) return { foreground: false, background: false };
  try {
    const { requestForegroundPermissionsAsync, getBackgroundPermissionsAsync } = nativeLocation();
    const foreground = await requestForegroundPermissionsAsync();
    if (!foreground.granted) return { foreground: false, background: false };
    const background = await getBackgroundPermissionsAsync();
    return { foreground: true, background: background.granted };
  } catch (e) {
    if (__DEV__) console.warn('[location] 위치 권한 요청 실패', errorText(e));
    return { foreground: false, background: false };
  }
}

// 이 앱의 폰 설정 화면 열기 — 항상 허용 · 정확한 위치는 여기서 켬
export async function openLocationSettings(): Promise<void> {
  await Linking.openSettings();
}

// 자동 기록 스위치 — 저장하고, 켜면 바로 감시 목록 등록(권한이 모자라면 register가 알아서 건너뜀), 끄면 등록한 지오펜스를 멈춤
//   던지지 않음 — 실패는 개발 중 콘솔에만. 부르는 쪽은 getLocationAuto로 저장된 값을 다시 읽어 화면을 맞춤
export async function setLocationAuto(on: boolean): Promise<void> {
  try {
    await saveLocationAuto(on);
    if (on) await syncLocation({ ignoreThrottle: true });
    else await stopGeofences();
  } catch (e) {
    if (__DEV__) console.warn('[location] 자동 기록 스위치 바꾸기 실패', errorText(e));
  }
}
