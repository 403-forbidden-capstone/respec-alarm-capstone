// 알람 코어 — 화면은 이 파일의 함수만 부름 (docs/alarm-core.md)
// 흐름: schedule(꾸러미) → AlarmManager → BroadcastReceiver → (WAKE) 포그라운드 서비스 + 잠금화면 위 화면 / (그 밖) 보통 알림(알림음 · 진동 한 번) + 원탭
// 울림 계획(볼륨 · 최대 시간 · 다시 울림 · 미루기 시간)은 plan.ts가 계산해서 넘기고, 네이티브는 받은 대로만 실행함
//
// 쓰는 곳에 따라 구현이 갈림 (화면은 모름):
//   Android + 모듈이 든 APK  → 네이티브 (isAvailable = true)
//   웹 · 그 밖의 플랫폼        → 메모리 대체: 예약 목록만 들고 울리지는 않음 (#98)
//   Android인데 모듈이 없는 옛 APK → 예약 · 울리기는 거절, 조회는 빈 값 ("예약된 줄 알았는데 안 울림" 방지)
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import { createMemoryBackend } from './memoryBackend';
import { createNativeBackend, type NativeAlarmCore } from './nativeBackend';
import { buildRingPlan, validateRingPackage } from './plan';
import type {
  AlarmBackend,
  AlarmEvent,
  RingPackage,
  ScheduleOutcome,
  ScheduledAlarm,
  ScheduleStatus,
  UsageSpan,
} from './types';

export * from './types';
export {
  buildRingPlan,
  canSnooze,
  DEFAULT_SNOOZE_LIMIT,
  DEFAULT_SOUND_KEY,
  isPastRing,
  isSnoozeLate,
  isSnoozeMinutesAllowed,
  MAX_RING_MILLIS,
  MIN_VOLUME_PERCENT,
  ringStartTimes,
  SNOOZE_LATE_LABEL,
  SNOOZE_MILLIS,
  SNOOZE_MINUTES_OPTIONS,
  snoozeCountLabel,
  snoozeLimitNotice,
  snoozeRingAt,
  unansweredSpanMillis,
  volumePercentFor,
} from './plan';
export { toUseSpans, type UseSpanMinutes } from './usage';
export { makeUuid } from './uuid';
export { RATING_WINDOW, TOO_LOUD_ADJUST, TOO_LOUD_COUNT, volumeAdjustFromRatings } from './volumeAdjust';

const MISSING_MODULE_MESSAGE = '이 APK에는 알람 모듈이 없음. 개발 빌드를 다시 설치해 주세요.';

const nativeModule =
  Platform.OS === 'android' ? requireOptionalNativeModule<NativeAlarmCore>('AlarmCore') : null;

/** 이 기기에서 네이티브 알람을 쓸 수 있는지 (Android + 모듈이 들어간 APK). 웹은 false */
export const isAvailable = nativeModule != null;

function chooseBackend(): AlarmBackend {
  if (nativeModule) return createNativeBackend(nativeModule);
  const memory = createMemoryBackend();
  if (Platform.OS !== 'android') return memory;
  const reject = () => Promise.reject(new Error(MISSING_MODULE_MESSAGE));
  return { ...memory, schedule: reject, ringNow: reject };
}

const backend = chooseBackend();

/**
 * 예약: 꾸러미의 atMillis에 울리게 폰에 걸음. 같은 alarmId면 덮어씀.
 * 시각이 이미 지났으면 던지지 않고 'skipped_past'를 돌려줌 (그 알람만 건너뜀, 8장 8.2.1 · 7장 7.1.4).
 * 꾸러미가 잘못됐거나 정확한 알람 권한이 없으면 reject.
 * 이미 울리는 중이거나 미뤄 둔(또는 다시 울림을 기다리는) 같은 알람은 건드리지 않음 — 서버와 맞추려고 다시 넘겨도 미루기가 풀리지 않게.
 * 이때 시각 · 강도가 이미 같으면 'scheduled', 다르면 새 꾸러미를 받지 않았다는 뜻으로 'deferred' (해제 뒤 다음 앱 맞추기에서 다시 넘김)
 */
export async function schedule(pkg: RingPackage): Promise<ScheduleStatus> {
  validateRingPackage(pkg);
  return backend.schedule(pkg, buildRingPlan(pkg));
}

/** 여러 개 예약 — 하나가 실패해도 나머지는 계속하고, 알람마다 결과를 돌려줌 (앱을 켤 때 서버와 맞추는 용도) */
export async function scheduleAll(pkgs: readonly RingPackage[]): Promise<ScheduleOutcome[]> {
  const outcomes: ScheduleOutcome[] = [];
  for (const pkg of pkgs) {
    try {
      outcomes.push({ alarmId: pkg.alarmId, status: await schedule(pkg) });
    } catch (error) {
      outcomes.push({
        alarmId: pkg?.alarmId ?? '',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/** 취소: 그 알람의 예약(미루기 · 다시 울림 포함)을 지우고, 그 알람이 울리는 중이면 멈춤. 없는 id는 아무 일 없음 */
export async function cancel(alarmId: string): Promise<void> {
  await backend.cancel(alarmId);
}

/** 전체 취소: 모든 예약을 지우고 울리는 중이면 멈춤 (로그아웃 정리에 씀) */
export async function cancelAll(): Promise<void> {
  await backend.cancelAll();
}

/** 폰에 걸린 예약 목록 (다음 울릴 시각 순) — 서버 alarms와 id · atMillis · intensity로 맞춰 봄 */
export async function list(): Promise<ScheduledAlarm[]> {
  return backend.list();
}

/** 끄기: 지금 울리는 알람을 해제 처리함(해제 기록이 남음). 울리는 게 없으면 아무 일 없음 */
export async function stop(): Promise<void> {
  await backend.stop();
}

/** 테스트: 예약 없이 지금 바로 울림. 같은 id가 있으면 덮어씀 */
export async function ringNow(pkg: RingPackage): Promise<void> {
  validateRingPackage(pkg);
  return backend.ringNow(pkg, buildRingPlan(pkg));
}

/** 정확한 알람 권한. 꺼져 있으면 schedule이 reject됨 */
export async function canScheduleExactAlarms(): Promise<boolean> {
  return backend.canScheduleExactAlarms();
}

/** 잠금화면 위 알람 화면(전체 화면 알림) 권한 */
export async function canUseFullScreenIntent(): Promise<boolean> {
  return backend.canUseFullScreenIntent();
}

/** 사용 정보 접근 권한(설정에서 켬)을 받았는지 — 기상 자동 확인에 필요 (#35) */
export async function hasUsageAccess(): Promise<boolean> {
  return backend.hasUsageAccess();
}

/** 사용 정보 접근 설정 화면을 엶. 돌아오면 hasUsageAccess()로 다시 확인 */
export async function openUsageAccessSettings(): Promise<void> {
  await backend.openUsageAccessSettings();
}

/**
 * 화면이 켜져 있고 잠금이 풀려 있던 구간(epoch ms)을 시각순으로 돌려줌. 권한이 없으면 reject.
 * 기상 판정 쪽 UseSpan으로는 toUseSpans(spans, 해제 시각)으로 바꿈
 */
export async function getUsageSpans(fromMillis: number, toMillis: number): Promise<UsageSpan[]> {
  return backend.getUsageSpans(fromMillis, toMillis);
}

/** 폰에 쌓인 울림 기록 중 아직 서버에 안 올린 것 (오래된 순) */
export async function getPendingEvents(): Promise<AlarmEvent[]> {
  return backend.getPendingEvents();
}

/** 서버에 올린 기록을 폰에서 지움. 올리는 데 성공한 clientEventId만 넘길 것 */
export async function markEventsUploaded(clientEventIds: string[]): Promise<void> {
  if (clientEventIds.length === 0) return;
  await backend.markEventsUploaded(clientEventIds);
}

/** 앱이 켜져 있는 동안 새 기록이 생기면 알림 (꺼져 있을 때 쌓인 것은 getPendingEvents로 읽음) */
export function addAlarmEventListener(listener: (event: AlarmEvent) => void): { remove(): void } {
  return backend.addEventListener(listener);
}
