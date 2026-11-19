// 시나리오 시험용 가짜 폰 — 알람 코어(네이티브) · 알림창 · expo-notifications · 지오펜스 등록을 한 곳에서 흉내 냄
//   앱 쪽은 실제 모듈이 그대로 도는데, 그 바깥(폰 OS · Kotlin)만 이 파일이 대신함
//   · 알람 코어: NativeAlarmCore를 구현 → alarm-core의 nativeBackend · plan이 실제로 돌고, 예약 목록(store) · 울림 기록(events)을 시험이 들여다봄
//     울림 규칙은 AlarmController.kt를 따름 — WAKE는 울림 · 다시 울림 예약, 그 밖은 알림을 띄우고 저장소에서 지움(fire), cancel은 그 알람의 알림도 거둠
//   · 알림창(tray): 네이티브가 띄운 알림(일정 알림 · 기상 확인 알림)과 expo-notifications가 띄운 알림(감지 안내 · 서버 푸시)을 한 목록으로 — "떠 있는 알림 id"
//   · 네이티브만 하는 일(DeviceUpload 즉시 올리기 · 해제 + 10분 판정 · 재부팅 복원)은 JS에서 안 보이므로, 하는 일을 nativeLog에 남기고 서버 쓰기는 db.nativeWrites로 따로 남김
//   서버 쪽(Kotlin)의 기상 판정은 앱과 같은 규칙(features/alarm/wake evaluateWake)을 가져다 씀 — 두 곳이 같은 규칙인지는 Kotlin 시험이 따로 봄
import type { AlarmEvent, AlarmType, RingingAlarm, ScheduledAlarm, ScheduleStatus, UsageSpan } from '@capstone/alarm-core';

import { evaluateWake } from '@/features/alarm/wake';
import { stableUuid } from '@/lib/uuid';

import { db } from './fakeDb';

type Plan = {
  sound: boolean;
  snoozeLimit: number;
  snoozeMinutesOptions: number[];
  reRingOffsetsMillis: number[];
  heading: string;
  oneTapLabel: string | null;
  oneTapEventType: 'ACKNOWLEDGED' | 'ARRIVAL_CONFIRMED' | null;
  maxRingMillis: number;
};
type Payload = {
  alarmId: string;
  type: AlarmType;
  atMillis: number;
  title: string;
  intensity: 'SOFT' | 'NORMAL' | 'STRONG';
  soundKey?: string;
  vibration?: 'NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS';
  voiceTone?: 'CALM' | 'NEUTRAL' | 'DIRECT';
  snoozeLimit: number;
  departAt?: number;
  plan: Plan;
};
type Stored = Payload & { ringing: boolean; snoozeCount: number; nextRingAt: number; ringCount: number };

export type TrayItem = {
  id: string; // 시험이 보는 이름: notice:<알람 id> · wakeprompt:<알람 id> · expo:<알림 번호>
  origin: 'native' | 'expo';
  kind: 'NOTICE' | 'WAKE_PROMPT' | 'DETECTION' | 'PUSH';
  alarmId?: string;
  alarmType?: AlarmType;
  oneTap?: string | null;
  data?: Record<string, unknown>;
};

type Listener = (event: AlarmEvent) => void;
export type NotificationListener = (n: { request: { identifier: string; content: { data: Record<string, unknown> } }; date: number }) => void;
export type ResponseListener = (r: { notification: { request: { identifier: string; content: { data: Record<string, unknown> } }; date: number } }) => void;

const MIN = 60_000;
const JUDGE_AFTER_MS = 10 * MIN + 2_000;

export class Phone {
  now: () => number = () => Date.now();
  // 앱 JS가 알림 받음 처리를 할 수 있는 상태인가 (앞에 있을 때) — 뒤 · 꺼짐이면 푸시는 알림창에만 뜨고 JS는 모름
  jsReceivesPush: () => boolean = () => true;

  store = new Map<string, Stored>();
  tray = new Map<string, TrayItem>();
  events: AlarmEvent[] = [];
  ringing: string | null = null;
  // 폰 안에서만 도는 예약(JS에서 안 보임): 해제 + 10분 판정 · 확인 알림
  judges: { alarmId: string; dismissedAt: number; at: number }[] = [];
  // 이미 확정됐다고 표시한 알람 — 네이티브가 같은 알람의 확인 알림을 다시 안 띄움 (WakePrompt)
  confirmedMarks = new Map<string, number>();
  nativeLog: string[] = []; // 네이티브가 한 일 — 예: dismissWakePrompt:<id> · judge:<id>:AUTO

  // 폰 상태 · 권한
  deviceKey = false; // 백그라운드 기기 키(briefing-device)가 폰에 있음 → 앱 없이 서버로 올림
  usageAccess = true;
  usageSpans: UsageSpan[] = [];
  exactAlarms = true;
  // 정확 알람 권한을 뺏겨 OS(AlarmManager)가 예약을 지움 — 폰 저장소 목록(list)에는 그대로 남아 있지만 울리지 않음 (안드로이드 12, AC:317-334)
  osAlarmsLost = false;
  notificationsGranted = true;
  online = true;

  // expo-notifications · 지오펜스 등록
  scheduledNotifications = new Map<string, unknown>();
  geofenceRegions: unknown[] | null = null; // OS에 등록된 지오펜스 (재부팅하면 사라짐)
  locationForeground = true;
  locationBackground = true;
  geofenceTasks = new Map<string, (body: unknown) => Promise<void> | void>();
  lastResponse: { notification: { request: { identifier: string; content: { data: Record<string, unknown> } }; date: number } } | null = null;
  receivedListeners = new Set<NotificationListener>();
  responseListeners = new Set<ResponseListener>();
  alarmListeners = new Set<Listener>();
  shownCount = 0;

  reset() {
    this.store.clear();
    this.tray.clear();
    this.events = [];
    this.ringing = null;
    this.judges = [];
    this.confirmedMarks.clear();
    this.nativeLog = [];
    this.deviceKey = false;
    this.usageAccess = true;
    this.usageSpans = [];
    this.exactAlarms = true;
    this.osAlarmsLost = false;
    this.notificationsGranted = true;
    this.online = true;
    this.scheduledNotifications.clear();
    this.geofenceRegions = null;
    this.locationForeground = true;
    this.locationBackground = true;
    this.lastResponse = null;
    this.receivedListeners.clear();
    this.responseListeners.clear();
    this.alarmListeners.clear();
    this.shownCount = 0;
    // geofenceTasks는 모듈을 불러올 때 한 번 정의되므로 비우지 않음
  }

  // ---------------------------------------------------------------------------
  // 시험이 부르는 것 — "폰이 한 일"
  // ---------------------------------------------------------------------------

  // 앱이 꺼져 있어도 폰이 직접 서버에 올림(DeviceUpload) — 기기 키가 있고 연결이 될 때만
  private uploadNow(event: AlarmEvent) {
    if (!this.deviceKey || !this.online || !db.userId) return;
    db.nativeInsert('alarm_events', {
      user_id: db.userId,
      alarm_id: event.alarmId,
      client_event_id: event.clientEventId,
      event_type: event.eventType,
      event_at: new Date(event.at).toISOString(),
      sequence_no: event.sequenceNo,
      snooze_minutes: event.snoozeMinutes ?? null,
      input_source: event.inputSource,
    });
    this.nativeLog.push(`upload:${event.eventType}:${event.alarmId}`);
  }

  private append(alarm: Stored | Payload, eventType: AlarmEvent['eventType'], sequenceNo = 1, snoozeMinutes?: number) {
    const event: AlarmEvent = {
      clientEventId: stableUuid('phone-event', alarm.alarmId, eventType, this.events.length, this.now()),
      alarmId: alarm.alarmId,
      alarmType: alarm.type,
      eventType,
      at: this.now(),
      sequenceNo,
      inputSource: 'BUTTON',
      ...(snoozeMinutes != null ? { snoozeMinutes } : {}),
    };
    this.events.push(event);
    this.alarmListeners.forEach((l) => l(event));
    // DeviceUploadRules.shouldUpload — 원탭 · 기상 해제만 바로 올림
    if (eventType === 'ACKNOWLEDGED' || eventType === 'ARRIVAL_CONFIRMED' || (eventType === 'DISMISSED' && alarm.type === 'WAKE')) this.uploadNow(event);
    if (eventType === 'DISMISSED' && alarm.type === 'WAKE') {
      // 해제 + 10분 2초에 판정 — 정확 알람 권한이 없으면 지연 작업(여기서는 같은 시각으로 둠)
      this.judges = this.judges.filter((j) => j.alarmId !== alarm.alarmId);
      this.judges.push({ alarmId: alarm.alarmId, dismissedAt: event.at, at: event.at + JUDGE_AFTER_MS });
    }
    return event;
  }

  // 알람 시각이 됨 (AlarmReceiver → AlarmController.fire)
  fire(alarmId: string) {
    const current = this.store.get(alarmId);
    if (!current) return;
    const ringCount = current.ringCount + 1;
    this.append(current, 'TRIGGERED', ringCount);
    if (!current.plan.sound) {
      this.store.delete(alarmId); // 일정 알림은 한 번 알리면 저장소에서 지움 (AC:155)
      this.showNotice({ ...current, ringCount });
      return;
    }
    const offset = current.plan.reRingOffsetsMillis[0];
    this.store.set(alarmId, { ...current, ringCount, ringing: true, nextRingAt: offset != null ? this.now() + offset : this.now() });
    this.ringing = alarmId;
  }

  // 지금 시각이 된 예약을 순서대로 울림 — 시계를 옮긴 뒤에 부름
  fireDue() {
    if (this.osAlarmsLost) return;
    const due = [...this.store.values()].filter((a) => !a.ringing && a.nextRingAt <= this.now()).sort((a, b) => a.nextRingAt - b.nextRingAt);
    for (const alarm of due) this.fire(alarm.alarmId);
  }

  private showNotice(alarm: Stored) {
    if (!this.notificationsGranted) return; // OS가 막음 (AN:98)
    this.tray.set(`notice:${alarm.alarmId}`, { id: `notice:${alarm.alarmId}`, origin: 'native', kind: 'NOTICE', alarmId: alarm.alarmId, alarmType: alarm.type, oneTap: alarm.plan.oneTapLabel });
  }

  // 사용자가 울리는 알람을 끔 (알람 화면 · 알림의 해제) — 해제 기록 + 판정 예약
  dismiss() {
    const id = this.ringing;
    const alarm = id ? this.store.get(id) : undefined;
    if (!id || !alarm) return;
    this.store.delete(id);
    this.ringing = null;
    this.append(alarm, 'DISMISSED', alarm.ringCount);
  }

  // 울림을 끝까지 두고 안 끔 (최대 시간 · 다시 울림이 다 지남) — 저장소에서 지움, 해제 기록 없음 (AC:188-190). 놓침은 서버가 판정
  letRingEnd() {
    const id = this.ringing;
    if (!id) return;
    this.store.delete(id);
    this.ringing = null;
  }

  // 일정 알림의 원탭 버튼 — 기록만 남기고 알림을 지움 (AC acknowledge)
  tapOneTap(alarmId: string) {
    const item = this.tray.get(`notice:${alarmId}`);
    if (!item?.alarmType || !item.oneTap) return false;
    const eventType = item.alarmType === 'ARRIVE' ? 'ARRIVAL_CONFIRMED' : 'ACKNOWLEDGED';
    this.append({ alarmId, type: item.alarmType } as Payload, eventType, 1);
    this.tray.delete(`notice:${alarmId}`);
    return true;
  }

  // 해제 + 10분 판정이 도는 시각 — 시계를 옮긴 뒤에 부름. 앱을 안 열어도 돎 (WakeJudgeReceiver)
  runJudges() {
    const due = this.judges.filter((j) => j.at <= this.now());
    this.judges = this.judges.filter((j) => !due.includes(j));
    for (const judge of due) {
      const spans = this.usageAccess ? this.usageSpans : null;
      const result = evaluateWake({
        dismissedAt: new Date(judge.dismissedAt),
        now: new Date(this.now()),
        spans: spans ? spans.map((s) => [(s.startMillis - judge.dismissedAt) / MIN, (s.endMillis - judge.dismissedAt) / MIN] as [number, number]) : null,
      });
      const confirmed = this.confirmedMarks.has(judge.alarmId) && this.now() - (this.confirmedMarks.get(judge.alarmId) ?? 0) < 12 * 60 * MIN;
      if (result.phase === 'auto' && result.reachedAt) {
        this.nativeLog.push(`judge:${judge.alarmId}:AUTO`);
        if (this.deviceKey && this.online && db.userId && !confirmed) {
          db.nativeInsert('alarm_events', {
            user_id: db.userId,
            alarm_id: judge.alarmId,
            client_event_id: stableUuid('wake-confirmed', judge.alarmId, judge.dismissedAt),
            event_type: 'WAKE_CONFIRMED',
            event_at: result.reachedAt.toISOString(),
            input_source: 'USAGE',
          });
          db.nativeInsert('daily_records', {
            user_id: db.userId,
            record_date: new Date(result.reachedAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 10),
            wake_confirmed_at: result.reachedAt.toISOString(),
            wake_reported_at: new Date(judge.dismissedAt).toISOString(),
            data_source: 'ALARM',
          });
          this.confirmedMarks.set(judge.alarmId, this.now());
        }
      } else if (result.phase === 'prompt' && !confirmed) {
        this.nativeLog.push(`judge:${judge.alarmId}:PROMPT`);
        if (this.notificationsGranted) {
          this.tray.set(`wakeprompt:${judge.alarmId}`, { id: `wakeprompt:${judge.alarmId}`, origin: 'native', kind: 'WAKE_PROMPT', alarmId: judge.alarmId, alarmType: 'WAKE' });
        }
      }
    }
  }

  // 기상 확인 알림을 누름 — 알림이 자동으로 닫히고(WP:61) 앱이 H08로 열림. 앱을 여는 일은 부르는 쪽(시나리오)이 함
  tapWakePrompt(alarmId: string) {
    return this.tray.delete(`wakeprompt:${alarmId}`);
  }

  // 위치 권한(항상)을 회수 — OS가 등록한 지오펜스를 지움
  revokeBackgroundLocation() {
    this.locationBackground = false;
    this.geofenceRegions = null;
  }

  // 폰 재부팅 — 예약된 알람은 되살아남(지난 것은 지움), 알림창 · 해제 후 판정 예약 · 지오펜스 등록은 사라짐 (AC:342-355, DU:113-124, LR:118)
  reboot() {
    for (const [id, alarm] of [...this.store]) {
      if (alarm.nextRingAt <= this.now() && !alarm.ringing) this.store.delete(id);
      else if (alarm.ringing) this.store.set(id, { ...alarm, ringing: false });
    }
    this.ringing = null;
    this.tray.clear();
    this.scheduledNotifications.clear();
    this.judges = [];
    this.geofenceRegions = null;
    this.nativeLog.push('reboot');
  }

  // 서버 푸시가 도착 — 알림창에는 늘 뜸. 앱 JS가 앞에 있으면(listener가 붙어 있으면) 받음 처리가 돎
  receivePush(data: Record<string, unknown>, identifier = `push-${this.shownCount + 1}`) {
    this.shownCount += 1;
    const n = { request: { identifier, content: { data } }, date: this.now() };
    if (this.notificationsGranted) this.tray.set(`expo:${identifier}`, { id: `expo:${identifier}`, origin: 'expo', kind: 'PUSH', data });
    if (this.jsReceivesPush()) this.receivedListeners.forEach((l) => l(n));
    return identifier;
  }

  // 알림을 누름 — 앱 JS가 돌고 있으면 응답 처리, 꺼져 있으면 마지막 응답으로 남겨 두고 앱이 열릴 때 읽음
  tapNotification(identifier: string) {
    const item = this.tray.get(`expo:${identifier}`);
    const response = { notification: { request: { identifier, content: { data: item?.data ?? {} } }, date: this.now() } };
    this.tray.delete(`expo:${identifier}`);
    if (this.responseListeners.size) this.responseListeners.forEach((l) => l(response));
    else this.lastResponse = response;
  }

  trayIds(): string[] {
    return [...this.tray.keys()].sort();
  }

  // ---------------------------------------------------------------------------
  // NativeAlarmCore — alarm-core가 부르는 폰 쪽 함수
  // ---------------------------------------------------------------------------

  native = {
    schedule: async (json: string): Promise<ScheduleStatus> => {
      if (!this.exactAlarms) throw new Error('정확한 알람 권한이 없어요');
      const p = JSON.parse(json) as Payload;
      if (p.atMillis <= this.now()) {
        this.store.delete(p.alarmId);
        return 'skipped_past';
      }
      const existing = this.store.get(p.alarmId);
      if (existing && (existing.ringing || existing.snoozeCount > 0)) {
        return existing.atMillis === p.atMillis && existing.intensity === p.intensity ? 'scheduled' : 'deferred';
      }
      this.store.set(p.alarmId, { ...p, ringing: false, snoozeCount: 0, nextRingAt: p.atMillis, ringCount: 0 });
      return 'scheduled';
    },
    cancel: async (alarmId: string) => {
      this.store.delete(alarmId);
      this.tray.delete(`notice:${alarmId}`); // AlarmNotifications.cancelNotice(id) — 저장소에 없어도 그 알람의 알림은 거둠
      if (this.ringing === alarmId) this.ringing = null;
    },
    cancelAll: async () => {
      for (const id of [...this.store.keys()]) this.tray.delete(`notice:${id}`);
      this.store.clear();
      for (const key of [...this.tray.keys()]) if (key.startsWith('notice:')) this.tray.delete(key); // cancelAllNotices — 일정 알림은 전부, 확인 알림(wakeprompt)은 그대로
      this.ringing = null;
    },
    list: async (): Promise<ScheduledAlarm[]> =>
      [...this.store.values()]
        .map((a): ScheduledAlarm => ({
          id: a.alarmId,
          type: a.type,
          intensity: a.intensity,
          soundKey: a.soundKey,
          vibration: a.vibration,
          voiceTone: a.voiceTone ?? null,
          title: a.title,
          atMillis: a.atMillis,
          snoozeCount: a.snoozeCount,
          nextRingAt: a.nextRingAt,
        }))
        .sort((x, y) => x.nextRingAt - y.nextRingAt),
    stop: async () => this.dismiss(),
    getRinging: async (): Promise<RingingAlarm | null> => {
      const a = this.ringing ? this.store.get(this.ringing) : undefined;
      if (!a) return null;
      return {
        id: a.alarmId,
        type: a.type,
        title: a.title,
        subtitle: null,
        atMillis: a.atMillis,
        nextRingAt: a.nextRingAt,
        snoozeCount: a.snoozeCount,
        snoozeLimit: a.snoozeLimit,
        snoozeMinutesOptions: a.plan.snoozeMinutesOptions,
        departAtMillis: a.departAt ?? null,
        heading: a.plan.heading,
        soundKey: a.soundKey ?? 'theme_default',
        vibration: a.vibration ?? 'SHORT_REPEAT',
        intensity: a.intensity,
        briefingText: null,
      };
    },
    snooze: async (minutes: number) => {
      const a = this.ringing ? this.store.get(this.ringing) : undefined;
      if (!a || !a.ringing || a.snoozeCount >= a.snoozeLimit) return false;
      this.store.set(a.alarmId, { ...a, ringing: false, snoozeCount: a.snoozeCount + 1, nextRingAt: this.now() + minutes * MIN });
      this.append(a, 'SNOOZED', a.ringCount, minutes);
      this.ringing = null;
      return true;
    },
    ackRingScreen: () => {},
    releaseRingOverLock: async () => {},
    ringNow: async () => {},
    canScheduleExactAlarms: async () => this.exactAlarms,
    canUseFullScreenIntent: async () => true,
    hasUsageAccess: async () => this.usageAccess,
    openUsageAccessSettings: async () => {},
    getUsageSpans: async (from: number, to: number): Promise<UsageSpan[]> => {
      if (!this.usageAccess) throw new Error('사용 정보 접근 권한이 없어요');
      return this.usageSpans.filter((s) => s.endMillis > from && s.startMillis < to).map((s) => ({ startMillis: Math.max(s.startMillis, from), endMillis: Math.min(s.endMillis, to) }));
    },
    getPendingEvents: async () => [...this.events],
    markEventsUploaded: async (ids: string[]) => {
      const done = new Set(ids);
      this.events = this.events.filter((e) => !done.has(e.clientEventId));
    },
    dismissWakePrompt: async (alarmId: string) => {
      this.nativeLog.push(`dismissWakePrompt:${alarmId}`);
      this.tray.delete(`wakeprompt:${alarmId}`);
      this.confirmedMarks.set(alarmId, this.now()); // 이미 확정됐다고 표시 — 더 안 띄움 (WP:66-70)
    },
    addListener: (_name: string, listener: Listener) => {
      this.alarmListeners.add(listener);
      return { remove: () => void this.alarmListeners.delete(listener) };
    },
    saveVoiceBriefing: async () => {},
    getVoiceBriefingHashes: async () => [] as string[],
    clearVoiceBriefing: async () => {},
  };

  // ---------------------------------------------------------------------------
  // expo-notifications · expo-location · expo-task-manager 가짜
  // ---------------------------------------------------------------------------

  notifications = {
    getPermissionsAsync: async () => ({ granted: this.notificationsGranted }),
    requestPermissionsAsync: async () => ({ granted: this.notificationsGranted }),
    scheduleNotificationAsync: async (request: { identifier?: string; content: { data?: Record<string, unknown> }; trigger?: unknown }) => {
      const id = request.identifier ?? `local-${(this.shownCount += 1)}`;
      const trigger = request.trigger as { channelId?: string; date?: unknown; seconds?: number } | null | undefined;
      if (trigger == null || (trigger.channelId && trigger.date == null && trigger.seconds == null)) {
        this.tray.set(`expo:${id}`, { id: `expo:${id}`, origin: 'expo', kind: 'DETECTION', data: request.content.data });
      } else {
        this.scheduledNotifications.set(id, request);
      }
      return id;
    },
    dismissNotificationAsync: async (id: string) => void this.tray.delete(`expo:${id}`),
    cancelScheduledNotificationAsync: async (id: string) => void this.scheduledNotifications.delete(id),
    setNotificationChannelAsync: async () => null,
    setNotificationHandler: () => {},
    getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[scenario]' }),
    getLastNotificationResponse: () => this.lastResponse,
    clearLastNotificationResponse: () => {
      this.lastResponse = null;
    },
    addNotificationReceivedListener: (l: NotificationListener) => {
      this.receivedListeners.add(l);
      return { remove: () => void this.receivedListeners.delete(l) };
    },
    addNotificationResponseReceivedListener: (l: ResponseListener) => {
      this.responseListeners.add(l);
      return { remove: () => void this.responseListeners.delete(l) };
    },
    AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2, MAX: 5, MIN: 1, NONE: 0, UNSPECIFIED: -1000 },
  };

  location = {
    GeofencingEventType: { Enter: 1, Exit: 2 },
    getForegroundPermissionsAsync: async () => ({ granted: this.locationForeground }),
    getBackgroundPermissionsAsync: async () => ({ granted: this.locationBackground }),
    hasStartedGeofencingAsync: async () => this.geofenceRegions != null,
    startGeofencingAsync: async (_task: string, regions: unknown[]) => {
      this.geofenceRegions = regions;
    },
    stopGeofencingAsync: async () => {
      this.geofenceRegions = null;
    },
  };

  taskManager = {
    defineTask: (name: string, executor: (body: unknown) => Promise<void> | void) => void this.geofenceTasks.set(name, executor),
  };

  // 폰 OS가 지오펜스를 드나듦을 알림 — 앱 화면이 없어도 작업이 돎 (헤드리스). 등록이 없으면(재부팅 · 끔) 신호가 안 옴
  async geofence(type: 'ENTER' | 'EXIT', regionId: string) {
    if (!this.geofenceRegions) return false;
    const task = this.geofenceTasks.get('respec-geofence');
    if (!task) throw new Error('지오펜스 작업이 정의되지 않음');
    await task({ data: { eventType: type === 'ENTER' ? 1 : 2, region: { identifier: regionId } } });
    return true;
  }
}

export const phone = new Phone();
