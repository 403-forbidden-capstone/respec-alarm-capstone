// 폰 권한 상태 읽기 + "알림을 물어봤는지" 기록 + 상태가 바뀌었다는 알림
//   알람 코어(@capstone/alarm-core)가 있는 Android 폰(개발용 APK)에서만 실제로 읽음 — 웹 · 가짜 · 옛 APK는 supported false
import * as AlarmCore from '@capstone/alarm-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PermissionsAndroid, Platform } from 'react-native';

import type { Allowed, NotifyReason, PermissionSnapshot } from './types';

// 실제로 읽을 수 있는 폰인지 (Android + 알람 코어 모듈이 든 APK)
export const canReadPhone = () => Platform.OS === 'android' && AlarmCore.isAvailable;

// 알림 허용 창이 있는 Android 13(API 33) 이상인지 — 그 아래는 설치하면 알림이 켜져 있어 시스템 창이 없음 (앱 알림 꺼짐 읽기는 PR 6 네이티브)
export const needsNotifyPermission = () => Number(Platform.Version) >= 33;

// ---------------------------------------------------------------------------
// 알림을 물어본 기록 — 폰 AsyncStorage에 키 하나 (로그아웃해도 그대로, 폰에 대한 기록이라)
// ---------------------------------------------------------------------------

const KEY = 'respec.notifyPrompt';
const REASONS: readonly NotifyReason[] = ['alarm', 'friend', 'onboarding', 'settings'];

export type NotifyRecord = {
  prompted: Partial<Record<NotifyReason, string>>; // 이유별로 처음 물어본 때 (ISO 시각) — 같은 이유로 두 번 조르지 않으려고
  blocked: boolean; // 시스템 창에서 "다시 묻지 않음"까지 간 적이 있음 — 다음 [켜기]부터는 설정을 엶
};

const emptyRecord = (): NotifyRecord => ({ prompted: {}, blocked: false });

function parseRecord(raw: string | null): NotifyRecord {
  if (!raw) return emptyRecord();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return emptyRecord();
    const { prompted, blocked } = value as { prompted?: unknown; blocked?: unknown };
    const out: NotifyRecord['prompted'] = {};
    if (typeof prompted === 'object' && prompted !== null) {
      for (const reason of REASONS) {
        const at = (prompted as Record<string, unknown>)[reason];
        if (typeof at === 'string') out[reason] = at;
      }
    }
    return { prompted: out, blocked: blocked === true };
  } catch {
    return emptyRecord(); // 깨진 기록은 처음부터
  }
}

// 읽기에 실패하면 빈 기록 (던지지 않음)
export async function readNotifyRecord(): Promise<NotifyRecord> {
  try {
    return parseRecord(await AsyncStorage.getItem(KEY));
  } catch {
    return emptyRecord();
  }
}

// 쓰기에 실패해도 던지지 않음 — 기록이 없으면 안내를 한 번 더 보일 뿐
export async function writeNotifyRecord(record: NotifyRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(record));
  } catch (e) {
    if (__DEV__) console.warn('[permissions] 알림 안내 기록 저장 실패', e);
  }
}

// ---------------------------------------------------------------------------
// 상태가 바뀌었다는 알림 — 묻기 · 설정 열기 뒤에 홈 빨간 줄 · 점검표가 바로 다시 읽게 (usePermissions가 구독)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

export function onPermissionsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPermissionsChanged(): void {
  for (const listener of [...listeners]) listener();
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

// 읽다가 실패하면 모름 — 꺼진 것처럼 보여서 빨간 줄을 띄우지 않게
async function allowed(read: () => Promise<boolean>): Promise<Allowed> {
  try {
    return (await read()) ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}

function readNotifications(): Promise<Allowed> {
  if (!needsNotifyPermission()) return Promise.resolve('unknown');
  return allowed(() => PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS));
}

// 던지지 않음 — 항목마다 실패하면 'unknown'
export async function readPermissions(): Promise<PermissionSnapshot> {
  const record = await readNotifyRecord();
  const notificationsAsked = record.blocked || Object.keys(record.prompted).length > 0;
  if (!canReadPhone()) {
    return { supported: false, notifications: 'unknown', notificationsAsked, fullScreen: 'unknown', exactAlarm: 'unknown', usageAccess: 'unknown' };
  }
  const [notifications, fullScreen, exactAlarm, usageAccess] = await Promise.all([
    readNotifications(),
    allowed(() => AlarmCore.canUseFullScreenIntent()),
    allowed(() => AlarmCore.canScheduleExactAlarms()),
    allowed(() => AlarmCore.hasUsageAccess()),
  ]);
  return { supported: true, notifications, notificationsAsked, fullScreen, exactAlarm, usageAccess };
}
