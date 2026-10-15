// 알람 코어 공용 타입 — 앱(TS)과 네이티브(Kotlin)가 같은 모양으로 주고받음
// 값 이름은 DB(alarm_type · alarm_intensity · alarm_event_type)와 같음

export const ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE', 'ROUTINE'] as const;
export type AlarmType = (typeof ALARM_TYPES)[number];

export const ALARM_INTENSITIES = ['SOFT', 'NORMAL', 'STRONG'] as const;
export type AlarmIntensity = (typeof ALARM_INTENSITIES)[number];

/** 진동 자리 — 아직 안 읽음 (D1 정해질 때까지 값 모양도 임시) */
export type AlarmVibration = 'NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS';

/**
 * 예약 꾸러미 — 서버 alarm-commit이 돌려주는 값을 그대로 폰에 넘기는 모양 (docs/alarm-core.md)
 * 앞 8칸이 alarm-core.md, 그 뒤 3칸이 #79에서 더한 칸, 마지막 2칸은 타입 자리만 있고 아직 안 읽음
 */
export type RingPackage = {
  /** 서버 alarms.alarm_id (UUID). 알람 종류는 id에서 읽지 않고 type으로 정함 */
  alarmId: string;
  type: AlarmType;
  /** alarms.scheduled_at (epoch ms) */
  atMillis: number;
  /** 약속 제목 */
  title: string;
  /** 예: "오전 10:00 · 세종대학교" */
  subtitle?: string;
  intensity: AlarmIntensity;
  /** 미루기 한도 — 저장만 하고 아직 안 읽음 (D3 정해질 때까지 횟수 제한 없음) */
  snoozeLimit: number;
  /** 음성 안내 문장 (나중, D8) — 저장만 하고 아직 안 읽음 */
  voiceText?: string;
  /** 소리 고르기. 폰에 든 소리가 하나뿐이라 지금은 모르는 값이면 기본 소리 */
  soundKey?: string;
  /** 평가 보정 비율. -0.1 = 볼륨 10% 줄임 (#81, volumeAdjust.ts) */
  volumeAdjust?: number;
  /** 출발 시각 (epoch ms) — 단축 준비 안내용, 아직 안 읽음 */
  departAt?: number;
  /** 자리만 — 안 읽음 (D1) */
  vibration?: AlarmVibration;
  /** 자리만 — 안 읽음 (D3). 지금은 10분 고정 */
  snoozeMinutesOptions?: readonly number[];
};

export type OneTapEventType = 'ACKNOWLEDGED' | 'ARRIVAL_CONFIRMED';

/** 울림 계획 — 공통(TS)이 계산하고 네이티브는 받은 대로만 실행함 (plan.ts) */
export type RingPlan = {
  /** true = 소리 + 잠금화면 위 알람 화면(WAKE), false = 소리 없는 알림 + 원탭 버튼 */
  sound: boolean;
  /** 알람 볼륨 최대치의 몇 % (소리 알람만, 평가 보정까지 반영, 10~100). 무음이면 0 */
  volumePercent: number;
  soundKey: string;
  /** 한 번 울리는 최대 시간 (ms). 무음이면 0 */
  maxRingMillis: number;
  /** 안 끄면 다시 울리는 시각 — 첫 울림 시작으로부터의 거리(ms). 비어 있으면 다시 울림 없음 */
  reRingOffsetsMillis: number[];
  /** 미루기 시간 (ms). 무음이면 0 */
  snoozeMillis: number;
  /** 알림 · 알람 화면에 쓰는 한 줄 (예: "일어날 시간이에요") */
  heading: string;
  /** 무음 알림의 원탭 버튼 글자. 소리 알람이면 null */
  oneTapLabel: string | null;
  /** 원탭을 누르면 남기는 기록 종류. 소리 알람이면 null */
  oneTapEventType: OneTapEventType | null;
};

/** 'scheduled' = 폰에 걸림, 'skipped_past' = 시각이 지나서 안 걸었음 (오류 아님) */
export type ScheduleStatus = 'scheduled' | 'skipped_past';

export type ScheduleOutcome = {
  alarmId: string;
  status: ScheduleStatus | 'failed';
  /** status가 'failed'일 때만 */
  error?: string;
};

/** list()가 돌려주는 한 줄 — 서버 alarms와 맞출 때 쓰는 값 */
export type ScheduledAlarm = {
  id: string;
  type: AlarmType;
  intensity: AlarmIntensity;
  title: string;
  /** 처음 예약한 시각 = 서버 scheduled_at */
  atMillis: number;
  snoozeCount: number;
  /** 다음에 실제로 울릴 시각 — 미뤘거나 다시 울림을 기다리면 atMillis와 다름 */
  nextRingAt: number;
};

export type AlarmEventType = 'TRIGGERED' | 'SNOOZED' | 'DISMISSED' | 'ACKNOWLEDGED' | 'ARRIVAL_CONFIRMED';

/**
 * 폰에 쌓이는 울림 기록 한 줄 — 앱이 alarm_events로 보내고 지움
 * clientEventId는 폰이 만든 UUID. DB의 중복 방지 칸에 그대로 넣음 (Q11)
 */
export type AlarmEvent = {
  clientEventId: string;
  alarmId: string;
  alarmType: AlarmType;
  eventType: AlarmEventType;
  /** 일어난 시각 (epoch ms) → alarm_events.event_at */
  at: number;
  /** SNOOZED일 때만 → snooze_minutes */
  snoozeMinutes?: number;
  /** 울림 회차 (미루기 · 다시 울림마다 늘어남, 1부터) → sequence_no */
  sequenceNo: number;
  /** → alarm_events.input_source. 폰 안 버튼은 항상 BUTTON (위치 · 사용 정보 자동은 앱이 따로 남김) */
  inputSource: 'BUTTON';
};

/** 화면이 켜져 있고 잠금이 풀려 있던 구간 (epoch ms) */
export type UsageSpan = { startMillis: number; endMillis: number };

/** 평가 종류 — DB alarm_feedback_type */
export type AlarmFeedback = 'GOOD' | 'TOO_LOUD' | 'TOO_QUIET' | 'VOICE_DISLIKE' | 'SOUND_DISLIKE';

/** 기기마다 다르게 구현하는 부분 — 네이티브 · 웹 대체가 같은 모양으로 맞춤 */
export type AlarmBackend = {
  schedule(pkg: RingPackage, plan: RingPlan): Promise<ScheduleStatus>;
  cancel(alarmId: string): Promise<void>;
  cancelAll(): Promise<void>;
  list(): Promise<ScheduledAlarm[]>;
  stop(): Promise<void>;
  ringNow(pkg: RingPackage, plan: RingPlan): Promise<void>;
  canScheduleExactAlarms(): Promise<boolean>;
  canUseFullScreenIntent(): Promise<boolean>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getUsageSpans(fromMillis: number, toMillis: number): Promise<UsageSpan[]>;
  getPendingEvents(): Promise<AlarmEvent[]>;
  markEventsUploaded(clientEventIds: string[]): Promise<void>;
  addEventListener(listener: (event: AlarmEvent) => void): { remove(): void };
};
