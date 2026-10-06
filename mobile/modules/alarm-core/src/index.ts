// 알람 코어 — 화면은 이 파일의 함수만 부름
// 흐름: AlarmManager.setAlarmClock → BroadcastReceiver → 포그라운드 서비스 → MediaPlayer(USAGE_ALARM)
// 아무도 안 끄면 5분 뒤 멈춤 (매일 반복 예약은 그대로). 미루기는 "<id>__snooze" 하나로 예약됨
// 지금은 Android만 있음. 웹 · iOS · 모듈 없는 옛 APK에서는 import해도 안 깨지고,
// 예약 · 테스트는 reject, 취소 · 끄기는 아무것도 안 함, 조회는 빈 값을 돌려줌
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type ScheduledAlarm = {
  id: string;
  title: string;
  /** 다음에 울릴 시각 (epoch ms) */
  triggerAtMillis: number;
  /** ONCE = 한 번, DAILY = 매일 */
  repeat: 'ONCE' | 'DAILY';
  /** 매일 반복일 때 시 · 분, 한 번이면 -1 */
  hour: number;
  minute: number;
};

type AlarmCoreNativeModule = {
  scheduleOneShot(id: string, title: string, atMillis: number): void;
  scheduleDaily(id: string, title: string, hour: number, minute: number): void;
  cancel(id: string): void;
  cancelAll(): void;
  getScheduledAlarms(): ScheduledAlarm[];
  canScheduleExactAlarms(): boolean;
  canUseFullScreenIntent(): boolean;
  startTest(title: string): void;
  stop(): void;
};

const nativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<AlarmCoreNativeModule>('AlarmCore')
    : null;

/** 이 기기에서 네이티브 알람을 쓸 수 있는지 (Android + 모듈이 들어간 APK) */
export const isAlarmCoreAvailable = nativeModule != null;

function requireAlarmCore(): AlarmCoreNativeModule {
  if (!nativeModule) {
    throw new Error(
      Platform.OS === 'android'
        ? '이 APK에는 알람 모듈이 없음. 개발 빌드를 다시 설치해 주세요.'
        : '알람은 Android에서만 동작함.',
    );
  }
  return nativeModule;
}

/** 예약: atMillis(epoch ms)에 한 번 울림. 같은 id면 덮어씀, 지난 시각이면 reject */
export async function scheduleOneShotAlarm(id: string, title: string, atMillis: number) {
  requireAlarmCore().scheduleOneShot(id, title, atMillis);
}

/** 반복: 매일 hour:minute에 울림 */
export async function scheduleDailyAlarm(id: string, title: string, hour: number, minute: number) {
  requireAlarmCore().scheduleDaily(id, title, hour, minute);
}

/** 취소: 그 알람과 딸린 미루기 예약을 지우고, 그 알람이 울리는 중이면 멈춤 */
export async function cancelAlarm(id: string) {
  nativeModule?.cancel(id);
}

/** 전체 취소: 모든 예약을 지우고, 울리는 중이면 멈춤 */
export async function cancelAllAlarms() {
  nativeModule?.cancelAll();
}

/** 예약 목록 (다음 울릴 시각 순) */
export async function getScheduledAlarms(): Promise<ScheduledAlarm[]> {
  return nativeModule?.getScheduledAlarms() ?? [];
}

/** 정확한 알람 권한. 꺼져 있으면 예약이 reject됨 */
export async function canScheduleExactAlarms(): Promise<boolean> {
  return nativeModule?.canScheduleExactAlarms() ?? false;
}

/** 잠금화면 위 알람 화면(전체 화면 알림) 권한 */
export async function canUseFullScreenIntent(): Promise<boolean> {
  return nativeModule?.canUseFullScreenIntent() ?? false;
}

/** 테스트: 예약 없이 지금 바로 울림 */
export async function startAlarmTest(title: string) {
  requireAlarmCore().startTest(title);
}

/** 끄기: 울리는 알람을 멈춤 (예약은 그대로) */
export async function stopAlarm() {
  nativeModule?.stop();
}
