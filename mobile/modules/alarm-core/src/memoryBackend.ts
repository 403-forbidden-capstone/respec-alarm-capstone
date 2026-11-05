// 웹 · 네이티브가 없는 곳의 대체 (#98) — 예약을 메모리에만 두고 울리지는 않음
// 웹 미리보기에서 "약속 만들기 → 알람 예약 → 목록"이 폰 없이 끝까지 보이게 하려는 것
// 새로고침하면 사라짐. isAvailable은 false로 남아 있어서 화면은 "실제로 울리지 않음"을 알 수 있음
import { canSnooze, isPastRing, isSnoozeMinutesAllowed, soundKeyOf, vibrationOf } from './plan';
import type { AlarmBackend, AlarmEvent, RingPackage, RingPlan, ScheduledAlarm, ScheduleStatus } from './types';
import { makeUuid } from './uuid';

type Entry = { pkg: RingPackage; plan: RingPlan };

export function createMemoryBackend(now: () => number = Date.now): AlarmBackend {
  const entries = new Map<string, Entry>();
  let events: AlarmEvent[] = [];
  // 울리는 척하는 알람 (ringNow가 소리 나는 알람이면 켜짐) — 미루기 횟수만 셈
  let ringing: (Entry & { snoozeCount: number }) | null = null;
  const listeners = new Set<(event: AlarmEvent) => void>();

  function record(pkg: RingPackage, eventType: AlarmEvent['eventType'], snoozeMinutes?: number) {
    const event: AlarmEvent = {
      clientEventId: makeUuid(),
      alarmId: pkg.alarmId,
      alarmType: pkg.type,
      eventType,
      at: now(),
      sequenceNo: 1,
      inputSource: 'BUTTON',
      ...(snoozeMinutes != null ? { snoozeMinutes } : {}),
    };
    events.push(event);
    listeners.forEach((listener) => listener(event));
  }

  return {
    async schedule(pkg, plan): Promise<ScheduleStatus> {
      if (isPastRing(pkg.atMillis, now())) {
        entries.delete(pkg.alarmId); // 시각이 지난 새 꾸러미는 예전 예약도 거둠 (네이티브와 같게)
        return 'skipped_past';
      }
      // 울림 · 미루기 상태가 없어서 네이티브와 달리 'deferred'는 돌려주지 않음 (언제나 덮어씀)
      entries.set(pkg.alarmId, { pkg, plan });
      return 'scheduled';
    },
    async cancel(alarmId) {
      entries.delete(alarmId);
    },
    async cancelAll() {
      entries.clear();
    },
    async list() {
      return [...entries.values()]
        .map(({ pkg }): ScheduledAlarm => ({
          id: pkg.alarmId,
          type: pkg.type,
          intensity: pkg.intensity,
          soundKey: soundKeyOf(pkg),
          vibration: vibrationOf(pkg),
          title: pkg.title,
          atMillis: pkg.atMillis,
          snoozeCount: 0,
          nextRingAt: pkg.atMillis,
        }))
        .sort((a, b) => a.nextRingAt - b.nextRingAt);
    },
    async stop() {
      ringing = null;
    },
    async getRinging() {
      if (!ringing) return null;
      const { pkg, plan, snoozeCount } = ringing;
      return {
        id: pkg.alarmId,
        type: pkg.type,
        title: pkg.title,
        subtitle: pkg.subtitle ?? null,
        atMillis: pkg.atMillis,
        nextRingAt: pkg.atMillis,
        snoozeCount,
        snoozeLimit: plan.snoozeLimit,
        snoozeMinutesOptions: plan.snoozeMinutesOptions.length > 0 ? plan.snoozeMinutesOptions : [5, 10, 15],
        departAtMillis: pkg.departAt ?? null,
        heading: plan.heading,
        soundKey: soundKeyOf(pkg),
        vibration: vibrationOf(pkg),
        intensity: pkg.intensity,
      };
    },
    async snooze(minutes) {
      if (!ringing) return false;
      const { plan, snoozeCount } = ringing;
      if (!canSnooze(snoozeCount, plan.snoozeLimit) || !isSnoozeMinutesAllowed(plan, minutes)) return false;
      record(ringing.pkg, 'SNOOZED', minutes);
      ringing = null;
      return true;
    },
    ackRingScreen() {},
    async releaseRingOverLock() {},
    async ringNow(pkg, plan) {
      if (plan.sound) ringing = { pkg, plan, snoozeCount: 0 };
      record(pkg, 'TRIGGERED'); // 소리 · 진동은 안 나지만 "울렸다"는 기록은 남겨서 기록 흐름을 확인할 수 있게
    },
    async canScheduleExactAlarms() {
      return false;
    },
    async canUseFullScreenIntent() {
      return false;
    },
    async hasUsageAccess() {
      return false;
    },
    async openUsageAccessSettings() {},
    async getUsageSpans() {
      return [];
    },
    async getPendingEvents() {
      return [...events];
    },
    async markEventsUploaded(clientEventIds) {
      const done = new Set(clientEventIds);
      events = events.filter((event) => !done.has(event.clientEventId));
    },
    addEventListener(listener) {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}
