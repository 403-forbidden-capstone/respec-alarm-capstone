// Android 네이티브 모듈(Kotlin, AlarmCore)과 주고받는 부분
// 복잡한 값(꾸러미 + 울림 계획)은 JSON 글자 하나로 넘김 — 네이티브가 그 글자를 그대로 저장해 두고 씀
import { toNativePayload } from './plan';
import type { AlarmBackend, AlarmEvent, RingingAlarm, ScheduledAlarm, ScheduleStatus, UsageSpan, VoiceTestInfo, VoiceTestStatus } from './types';

/** Kotlin AlarmCoreModule이 내놓는 함수 모양 (이름이 AsyncFunction 이름과 같아야 함) */
export type NativeAlarmCore = {
  schedule(payload: string): Promise<ScheduleStatus>;
  cancel(alarmId: string): Promise<void>;
  cancelAll(): Promise<void>;
  list(): Promise<ScheduledAlarm[]>;
  stop(): Promise<void>;
  getRinging(): Promise<RingingAlarm | null>;
  snooze(minutes: number): Promise<boolean>;
  ackRingScreen(): void;
  releaseRingOverLock(dismissKeyguard: boolean): Promise<void>;
  ringNow(payload: string): Promise<void>;
  canScheduleExactAlarms(): Promise<boolean>;
  canUseFullScreenIntent(): Promise<boolean>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getUsageSpans(fromMillis: number, toMillis: number): Promise<UsageSpan[]>;
  getPendingEvents(): Promise<AlarmEvent[]>;
  markEventsUploaded(clientEventIds: string[]): Promise<void>;
  addListener(eventName: 'onAlarmEvent', listener: (event: AlarmEvent) => void): { remove(): void };
  // 아래 셋은 AI 음성 브리핑 칸 — 이 칸이 없는 예전 APK에서는 undefined (createNativeBackend가 조용히 건너뜀)
  saveVoiceBriefing?(alarmId: string, json: string): Promise<void>;
  getVoiceBriefingHashes?(alarmId: string): Promise<string[]>;
  clearVoiceBriefing?(alarmId: string): Promise<void>;
  // 개발 화면 AI 음성 시험 — 예전 APK에서는 undefined (index.ts가 안내 문구로 거절)
  ringVoiceTest?(payload: string, voiceJson: string): Promise<VoiceTestInfo>;
  voiceTestStatus?(): Promise<VoiceTestStatus>;
  stopVoiceTest?(alarmId: string | null): Promise<void>;
};

export function createNativeBackend(native: NativeAlarmCore): AlarmBackend {
  return {
    schedule: (pkg, plan) => native.schedule(toNativePayload(pkg, plan)),
    cancel: (alarmId) => native.cancel(alarmId),
    cancelAll: () => native.cancelAll(),
    list: () => native.list(),
    stop: () => native.stop(),
    getRinging: () => native.getRinging(),
    snooze: (minutes) => native.snooze(minutes),
    ackRingScreen: () => native.ackRingScreen(),
    releaseRingOverLock: (dismissKeyguard) => native.releaseRingOverLock(dismissKeyguard),
    ringNow: (pkg, plan) => native.ringNow(toNativePayload(pkg, plan)),
    canScheduleExactAlarms: () => native.canScheduleExactAlarms(),
    canUseFullScreenIntent: () => native.canUseFullScreenIntent(),
    hasUsageAccess: () => native.hasUsageAccess(),
    openUsageAccessSettings: () => native.openUsageAccessSettings(),
    getUsageSpans: (fromMillis, toMillis) => native.getUsageSpans(fromMillis, toMillis),
    getPendingEvents: () => native.getPendingEvents(),
    markEventsUploaded: (clientEventIds) => native.markEventsUploaded(clientEventIds),
    addEventListener: (listener) => native.addListener('onAlarmEvent', listener),
    // 예전 APK(함수 없음)면 저장하지 않음 → 알람은 기본 알람음으로 그대로 울림
    saveVoiceBriefing: async (alarmId, value) => {
      await native.saveVoiceBriefing?.(alarmId, JSON.stringify(value));
    },
    getVoiceBriefingHashes: async (alarmId) => (await native.getVoiceBriefingHashes?.(alarmId)) ?? [],
    clearVoiceBriefing: async (alarmId) => {
      await native.clearVoiceBriefing?.(alarmId);
    },
  };
}
