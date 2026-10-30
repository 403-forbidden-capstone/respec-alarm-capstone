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
 * 앞 8칸이 alarm-core.md, 그 뒤 3칸이 #79에서 더한 칸, `notice`가 알림 문구 칸, 마지막 2칸은 타입 자리만 있고 아직 안 읽음
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
  /** 미루기 한도 (알람 한 개당, 서버 alarms.snooze_limit 기본 3). 울림 계획(RingPlan.snoozeLimit)에 실려 네이티브가 셈 (D3 A) */
  snoozeLimit: number;
  /** 음성 안내 문장 (나중, D8) — 저장만 하고 아직 안 읽음. 서버가 약속의 기상 알람에 채움 ("좋은 아침이에요. 오늘 첫 일정은 …") */
  voiceText?: string;
  /**
   * 알림 한 줄 — 있으면 RingPlan.heading(알림 · 알람 화면의 줄)이 이 글자가 되고, 없으면 종류별 기본 줄.
   * 서버가 약속의 준비 · 출발 알림에 채움 (예: "오전 8:40 출발까지 30분" · "지금 나가면 오전 9:50 도착 · 여유 10분").
   * 네이티브는 이 칸을 모르고 plan.heading만 읽어 저장하므로 재부팅 뒤 다시 걸어도 그대로 남음
   */
  notice?: string;
  /** 소리 고르기. 지금은 어떤 값이든 기본 소리(폰 기본 알람음). 앱에 든 소리가 늘면 그 키는 앱 파일을 먼저 틂 */
  soundKey?: string;
  /** 평가 보정 비율. -0.1 = 볼륨 10% 줄임 (#81, volumeAdjust.ts) */
  volumeAdjust?: number;
  /** 출발 시각 (epoch ms) — 미루기 한도 안내("지금 바로 준비 · 출발 시각")와 "이만큼 미루면 늦어요" 판단에 씀 (D3 A) */
  departAt?: number;
  /** 자리만 — 안 읽음 (D1) */
  vibration?: AlarmVibration;
  /** 자리만 — 안 읽음. 미루기 시간은 5 · 10 · 15분 고정(D3 A, SNOOZE_MINUTES_OPTIONS)이라 이 칸으로 바꾸지 않음 */
  snoozeMinutesOptions?: readonly number[];
};

export type OneTapEventType = 'ACKNOWLEDGED' | 'ARRIVAL_CONFIRMED';

/** 울림 계획 — 공통(TS)이 계산하고 네이티브는 받은 대로만 실행함 (plan.ts) */
export type RingPlan = {
  /** true = 알람음 + 계속 진동 + 잠금화면 위 알람 화면(WAKE), false = 보통 알림(알림음 · 진동 한 번) + 원탭 버튼 */
  sound: boolean;
  /** 알람 볼륨 최대치의 몇 % (알람음이 나는 알람만, 평가 보정까지 반영, 10~100). 보통 알림이면 0 */
  volumePercent: number;
  soundKey: string;
  /** 한 번 울리는 최대 시간 (ms). 보통 알림이면 0 */
  maxRingMillis: number;
  /** 안 끄면 다시 울리는 시각 — 첫 울림 시작으로부터의 거리(ms). 비어 있으면 다시 울림 없음 */
  reRingOffsetsMillis: number[];
  /** 기본 미루기 시간 (ms) — 알림의 "미루기" 버튼이 쓰는 값. 보통 알림이면 0 */
  snoozeMillis: number;
  /** 알람 화면에서 고를 수 있는 미루기 시간 (분). 보통 알림이면 빈 목록 */
  snoozeMinutesOptions: number[];
  /** 미루기 한도 (횟수, 다시 울림은 안 셈). 보통 알림이면 0 */
  snoozeLimit: number;
  /** 알림 · 알람 화면에 쓰는 한 줄 (예: "일어날 시간이에요") */
  heading: string;
  /** 보통 알림의 원탭 버튼 글자. 알람음이 나는 알람이면 null */
  oneTapLabel: string | null;
  /** 원탭을 누르면 남기는 기록 종류. 알람음이 나는 알람이면 null */
  oneTapEventType: OneTapEventType | null;
};

/**
 * 'scheduled' = 폰에 걸림 (이미 같은 시각 · 강도로 걸려 있어도),
 * 'skipped_past' = 시각이 지나서 안 걸었음 (오류 아님),
 * 'deferred' = 지금 울리거나 미룬 중인 같은 알람이라 새 꾸러미를 받지 않음 (시각 · 강도가 다를 때만) → 해제 뒤 다음 앱 맞추기(앱을 열 때)에서 다시 넘김
 */
export type ScheduleStatus = 'scheduled' | 'skipped_past' | 'deferred';

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
 * clientEventId는 폰이 만든 UUID. DB의 중복 방지 칸에 그대로 넣음 (Q11, 칸은 #160에서 추가)
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
  /** → alarm_events.input_source (#160에서 추가). 폰 안 버튼은 항상 BUTTON (위치 · 사용 정보 자동은 앱이 따로 남김) */
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
