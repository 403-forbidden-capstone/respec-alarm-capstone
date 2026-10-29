// 폰 설정 화면 열기 — 실패해도 던지지 않음 (안 열리면 앱 정보 화면으로)
// 설정에서 돌아오면 앱이 앞에 오므로 usePermissions가 다시 읽음 — 여기서 따로 할 일은 없음
import * as AlarmCore from '@capstone/alarm-core';
import Constants from 'expo-constants';
import { Linking } from 'react-native';

const FALLBACK_PACKAGE = 'com.forbidden403.respecalarm'; // app.json android.package

// 앱 정보 화면 (권한 · 알림 · 배터리가 한 곳에) — 다른 설정 화면을 못 열 때의 마지막 길
async function openAppInfo(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (e) {
    if (__DEV__) console.warn('[permissions] 앱 정보 화면을 못 엶', e);
  }
}

async function openIntent(action: string, extras?: { key: string; value: string }[]): Promise<void> {
  try {
    await Linking.sendIntent(action, extras);
  } catch (e) {
    if (__DEV__) console.warn(`[permissions] 설정 화면을 못 엶 (${action}) — 앱 정보로`, e);
    await openAppInfo();
  }
}

// 이 앱의 알림 설정
export function openAppNotificationSettings(): Promise<void> {
  const packageName = Constants.expoConfig?.android?.package ?? FALLBACK_PACKAGE;
  return openIntent('android.settings.APP_NOTIFICATION_SETTINGS', [{ key: 'android.provider.extra.APP_PACKAGE', value: packageName }]);
}

// 전체화면 알림 설정(ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)은 package URI가 있어야 열려 sendIntent로 못 엶 → PR 6 네이티브. 그 전까지는 앱 정보
export function openFullScreenSettings(): Promise<void> {
  return openAppInfo();
}

// 정확한 알람 설정(ACTION_REQUEST_SCHEDULE_EXACT_ALARM)도 같은 이유로 PR 6 네이티브 전까지 앱 정보
export function openExactAlarmSettings(): Promise<void> {
  return openAppInfo();
}

// 배터리 최적화 목록 — 예외를 바로 "요청"하는 인텐트(REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)는 알람 앱이 Play 인정 용도 표에 없어 안 씀 · 권한 선언도 안 함
export function openBatterySettings(): Promise<void> {
  return openIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
}

// 사용 정보 접근 설정 (알람 코어가 엶)
export async function openUsageAccessSettings(): Promise<void> {
  try {
    await AlarmCore.openUsageAccessSettings();
  } catch (e) {
    if (__DEV__) console.warn('[permissions] 사용 정보 접근 설정을 못 엶 — 앱 정보로', e);
    await openAppInfo();
  }
}
