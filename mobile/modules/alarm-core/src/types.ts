// 알람 코어 공용 타입 — 앱(TS)과 네이티브(Kotlin)가 같은 모양으로 주고받음
// 값 이름은 DB(alarm_type · alarm_intensity · alarm_event_type)와 같음

export const ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE', 'ROUTINE'] as const;
export type AlarmType = (typeof ALARM_TYPES)[number];

export const ALARM_INTENSITIES = ['SOFT', 'NORMAL', 'STRONG'] as const;
export type AlarmIntensity = (typeof ALARM_INTENSITIES)[number];

/** 진동 3종 — 서버 alarms.vibration · 네이티브 AlarmVibration과 같은 이름 (D1 A: 약 NONE · 보통 SHORT_REPEAT · 강 STRONG_CONTINUOUS) */
export const ALARM_VIBRATIONS = ['NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS'] as const;
export type AlarmVibration = (typeof ALARM_VIBRATIONS)[number];

/** 말소리 3종 — 서버 alarms.voice_tone과 같은 이름 */
export type VoiceTone = 'CALM' | 'NEUTRAL' | 'DIRECT';

/**
 * 예약 꾸러미 — 서버 alarm-commit이 돌려주는 값을 그대로 폰에 넘기는 모양 (docs/alarm-core.md)
 * 앞 8칸이 alarm-core.md, 그 뒤 3칸이 #79에서 더한 칸, `notice`가 알림 문구 칸, `soundKey` · `vibration`이 축별 강도 칸(D1 A, 서버가 늘 채움), 마지막 칸은 타입 자리만 있고 아직 안 읽음
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
  /** 미루기 한도 (알람 한 개당, 서버 alarms.snooze_limit 기본 3). 울림 계획(RingPlan.snoozeLimit)에 실려 네이티브가 셈 (D3 기본안 A) */
  snoozeLimit: number;
  /** 음성 안내 문장 (나중, D8) — 저장만 하고 아직 안 읽음. 서버가 약속의 기상 알람에 채움 ("좋은 아침이에요. 오늘 첫 일정은 …") */
  voiceText?: string;
  /**
   * 알림 한 줄 — 있으면 RingPlan.heading(알림 · 알람 화면의 줄)이 이 글자가 되고, 없으면 종류별 기본 줄.
   * 서버가 약속의 준비 · 출발 알림에 채움 (예: "오전 8:40 출발까지 30분" · "지금 나가면 오전 9:50 도착 · 여유 10분").
   * 네이티브는 이 칸을 모르고 plan.heading만 읽어 저장하므로 재부팅 뒤 다시 걸어도 그대로 남음
   */
  notice?: string;
  /**
   * 배경음 — 서버가 `sound_key ?? 강도에서`로 풀어 늘 채움 (약 theme_calm · 보통 theme_default · 강 theme_urgent).
   * 없으면(예전 서버 · 손으로 만든 꾸러미) 네이티브에 넘길 때 강도에서 정함. 앱에 든 소리 키는 앱 파일을 먼저 틀고, 모르는 키는 폰 기본 알람음
   */
  soundKey?: string;
  /** 평가 보정 비율. -0.1 = 볼륨 10% 줄임 (#81, volumeAdjust.ts) */
  volumeAdjust?: number;
  /** 출발 시각 (epoch ms) — 미루기 한도 안내("지금 바로 준비 · 출발 시각")와 "이만큼 미루면 늦어요" 판단에 씀 (D3 기본안 A) */
  departAt?: number;
  /** 출발 알람만 — 이 약속은 위치(지오펜스)로 출발을 자동 판단함. true면 출발 알람 해제는 출발이 아님(DISMISSED만), false · 없음이면 해제가 출발(ACKNOWLEDGED도 기록). 앱 맞추기가 권한 · 집 위치 · 감시 대상으로 정해 실음 */
  departByLocation?: boolean;
  /**
   * 진동 — 서버가 `vibration ?? 강도에서`로 풀어 늘 채움. 없거나 모르는 값이면 네이티브에 넘길 때 강도에서 정함
   * (약 NONE · 보통 SHORT_REPEAT · 강 STRONG_CONTINUOUS). 볼륨 · 다시 울림은 이 칸이 아니라 intensity가 정함
   */
  vibration?: AlarmVibration;
  /**
   * 말소리 (서버 alarms.voice_tone, 자동 또는 직접 고름) — AI 음성 시작 단계 약 CALM 1 · 중 NEUTRAL 2 · 강 DIRECT 3.
   * 서버가 늘 채움. 없으면(예전 서버) 저장된 브리핑의 시작 단계, 그것도 없으면 1
   */
  voiceTone?: VoiceTone;
  /** 자리만 — 안 읽음. 미루기 시간은 5 · 10 · 15분 고정(D3 기본안 A, SNOOZE_MINUTES_OPTIONS)이라 이 칸으로 바꾸지 않음 */
  snoozeMinutesOptions?: readonly number[];
};

export type OneTapEventType = 'ACKNOWLEDGED' | 'ARRIVAL_CONFIRMED';

/** 울림 계획 — 공통(TS)이 계산하고 네이티브는 받은 대로만 실행함 (plan.ts) */
export type RingPlan = {
  /** true = 알람음 + 계속 진동 + 잠금화면 위 알람 화면(기상 · 준비 · 출발), false = 보통 알림(알림음 · 진동 한 번) + 원탭 버튼(도착 · 루틴) */
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
  /** 출발 알람만 — 위치로 출발을 판단하는 약속인지 (RingPackage.departByLocation). 네이티브가 앱이 꺼진 채 해제될 때 출발 기록을 더할지 가름. 다른 종류는 칸 없음 */
  departByLocation?: boolean;
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
  /** 폰에 걸린 배경음 · 진동 (서버 꾸러미의 soundKey · vibration). 이 칸을 모르는 예전 APK는 안 돌려줌 → 없으면 강도를 따른 것으로 봄 */
  soundKey?: string;
  vibration?: AlarmVibration;
  /** 폰에 걸린 말소리 (꾸러미의 voiceTone). 칸이 없던 예약은 null, 이 칸을 모르는 예전 APK는 안 돌려줌(undefined) → 비교하지 않음 */
  voiceTone?: VoiceTone | null;
  /** 폰에 걸린 출발 알람의 위치 판단 여부 (plan.departByLocation). 다른 종류 · 이 칸을 모르는 예전 APK는 안 돌려줌 → 비교하지 않음 */
  departByLocation?: boolean;
  /** 폰에 걸린 계획이 알람음이 있는 알람인지 (plan.sound). 이 칸을 모르는 예전 APK는 안 돌려줌 → 비교하지 않음. 예전에 알림으로 걸린 준비 · 출발을 알람으로 다시 걸게 알아보는 데 씀 (11/19) */
  sound?: boolean;
  title: string;
  /** 처음 예약한 시각 = 서버 scheduled_at */
  atMillis: number;
  snoozeCount: number;
  /** 다음에 실제로 울릴 시각 — 미뤘거나 다시 울림을 기다리면 atMillis와 다름 */
  nextRingAt: number;
};

/**
 * 지금 울리는 알람 — getRinging()이 돌려주는 값. 앱 H07(/ring)이 그리는 데 필요한 것만 (네이티브 알람 화면이 쓰는 값과 같은 출처)
 * 해제하면 폰에서 알람이 지워지므로 화면은 처음 읽은 값을 들고 있어야 함
 */
export type RingingAlarm = {
  id: string;
  type: AlarmType;
  title: string;
  subtitle: string | null;
  /** 처음 예약한 시각 (서버 scheduled_at) */
  atMillis: number;
  /** 지금 울림의 시각 — 미뤘거나 다시 울림이면 atMillis와 다름 */
  nextRingAt: number;
  /** 이미 미룬 횟수 */
  snoozeCount: number;
  snoozeLimit: number;
  /** 고를 수 있는 미루기 분. 계획에 없으면 5 · 10 · 15 */
  snoozeMinutesOptions: number[];
  /** 출발 시각 (epoch ms). 모르면 null */
  departAtMillis: number | null;
  /** 알람 화면의 머리글 (예: "일어날 시간이에요") */
  heading: string;
  soundKey: string;
  vibration: AlarmVibration;
  intensity: AlarmIntensity;
  /** AI 음성 브리핑 문장 (지금 단계) — 음성을 못 틀어도 화면에 일정 안내가 남게. 브리핑이 없으면 null · 예전 APK는 칸 없음 */
  briefingText?: string | null;
};

/**
 * 음성 브리핑 저장 값 — 서버 alarm-briefing 응답 그대로 (supabase/functions/_shared/briefing-run.ts BriefingOut)
 * 네이티브가 알람별 앱 전용 폴더에 단계별 WAV로 저장하고, 울릴 때 미루기 횟수 · 남은 여유로 단계를 골라 틂 (VoiceBriefing.kt)
 */
export type VoiceBriefingSave = {
  /** urgentAtMs = 남은 여유가 0분이 되는 시각(준비 · 이동을 모르면 null), maxLevel = 상한(늘 4), startLevel = 말소리 시작 단계(예약의 voiceTone이 있으면 그것이 먼저) — 네이티브 SpeechUrgency가 울릴 때 비교 */
  rule: { urgentAtMs: number | null; maxLevel: number; startLevel?: number } | null;
  /** 단계별 문장 + Android TTS 높낮이 · 속도 · 목소리 번호 */
  clips: { level: number; hash: string; text: string; pitch: number; rate: number; voiceIndex: number }[];
  audio: { level: number; hash: string; mime?: string; data: string }[];
  /** 서버 refresh_at — 전날 대화가 아직 새벽 정리 전이면 다시 받을 시각(ms). 네이티브가 백그라운드 갱신 예약에 더함 (#515, BriefingRefresh.kt) */
  refreshAt?: number | null;
};

/**
 * 백그라운드 브리핑 갱신(#515)용 기기 키 — 네이티브가 Android Keystore로 암호화해 둠 (BriefingCredential.kt)
 * url = alarm-briefing-device 주소, apikey = 공개 키(EXPO_PUBLIC_), token = briefing-device가 준 원문(bdk_…), expiresAt = ms
 */
export type BriefingDeviceKey = { url: string; apikey: string; token: string; userId: string; deviceId: string; expiresAt: number };
/** 앱이 읽는 정보 — 키 원문은 네이티브 밖으로 안 나옴 */
export type BriefingDeviceInfo = Pick<BriefingDeviceKey, 'userId' | 'deviceId' | 'expiresAt'>;

/**
 * 개발 화면 AI 음성 시험 — 샘플 문장 + 끌 것 (sound: 알람음 크기 0, voice: AI 음성 안 읽음)
 * gemini: 3 · 4단계 음성 출처 모의 (네이티브 VoiceTest.geminiMode) — CACHE(기본) 실제 알람이 받아 둔 개인화 캐시(없으면 예비 WAV)
 *   · FALLBACK 캐시 없음(한도 초과 · 네트워크 실패 · 비행기 모드와 같음) → 그 단계 예비 WAV · BROKEN 깨진 캐시 → 예비 WAV · ANDROID 예비 WAV도 못 씀 → Android TTS
 * Gemini WAV 재생 속도는 고정 (3단계 1.0배 · 4단계 1.2배, 네이티브 BriefingRules.wavSpeed)
 */
export type VoiceTestSetup = Pick<VoiceBriefingSave, 'rule' | 'clips'> & {
  test: { sound: boolean; voice: boolean; gemini?: VoiceTestGemini };
};
export type VoiceTestGemini = 'CACHE' | 'FALLBACK' | 'BROKEN' | 'ANDROID';

/** 음성 출처 (네이티브 BriefingRules.source) — 개인화 Gemini 캐시 · 앱에 든 Gemini 예비 WAV · Android TTS · Android TTS 대체(3 · 4단계) */
export type VoiceSource = 'GEMINI_CACHE' | 'GEMINI_FALLBACK' | 'ANDROID' | 'ANDROID_FALLBACK';

/** 이번 시험 울림이 고른 음성 (네이티브 VoiceBriefing.speechFor 결과). engine NONE = 음성 없음 */
export type VoiceTestInfo = {
  level: number | null;
  engine: 'GEMINI' | 'ANDROID' | 'NONE';
  text: string | null;
  pitch: number | null;
  rate: number | null;
  voiceIndex: number | null;
  /** Gemini 음성을 빌려 온 실제 알람 id (없으면 null) */
  geminiSourceAlarmId: string | null;
  /** 고른 첫 출처 · WAV 재생 속도. 예전 APK면 없음 */
  source?: VoiceSource | null;
  speed?: number | null;
};

/** 지금 재생 상태 (1초마다 읽음) */
export type VoiceTestStatus = {
  ringingAlarmId: string | null;
  departureSpeakingAlarmId: string | null;
  /** 마지막으로 튼 알람음 주소 */
  sound: string | null;
  /** 마지막 음성 상태 한 줄 (Android TTS 읽는 중 · 캐시된 Gemini 재생 중 · 한국어 TTS 없음 등) */
  speech: string | null;
  /** 지금 읽는 AI 음성 단계 · 엔진 (울리는 중 시간이 지나 1 → 3 → 4로 바뀌는 것을 봄). 예전 APK면 없음 */
  level?: number | null;
  engine?: 'GEMINI' | 'ANDROID' | null;
  /** 실제로 소리를 낸 출처 (재생 실패로 다음 출처로 넘어가면 바뀜) */
  source?: VoiceSource | null;
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
  /** 지금 울리는 알람. 없으면 null */
  getRinging(): Promise<RingingAlarm | null>;
  /** 지금 울리는 알람을 minutes분 미룸. 한도 · 허용 분을 넘었거나 울리는 게 없으면 false */
  snooze(minutes: number): Promise<boolean>;
  /** 앱이 H07(/ring)을 띄웠다고 네이티브 길잡이 화면에 알림 */
  ackRingScreen(): void;
  /** 알람이 끝나 H07의 잠금화면 위 설정을 되돌림. dismissKeyguard = 해제(true)면 잠금 해제도 요청, 미루기(false)면 앱을 뒤로 보냄 */
  releaseRingOverLock(dismissKeyguard: boolean): Promise<void>;
  ringNow(pkg: RingPackage, plan: RingPlan): Promise<void>;
  canScheduleExactAlarms(): Promise<boolean>;
  canUseFullScreenIntent(): Promise<boolean>;
  hasUsageAccess(): Promise<boolean>;
  openUsageAccessSettings(): Promise<void>;
  getUsageSpans(fromMillis: number, toMillis: number): Promise<UsageSpan[]>;
  getPendingEvents(): Promise<AlarmEvent[]>;
  markEventsUploaded(clientEventIds: string[]): Promise<void>;
  /** 기상이 확정됐을 때 부름 — 폰이 띄운 "지금 일어나셨나요?" 알림을 거두고, 이미 확정됐다고 표시해 더 안 띄움 (Android만, iOS · 웹은 아무것도 안 함) */
  dismissWakePrompt(alarmId: string): Promise<void>;
  addEventListener(listener: (event: AlarmEvent) => void): { remove(): void };
  /** AI 음성 브리핑 저장 — 새 음성은 쓰고, 열쇠가 같은 예전 음성만 남기고, 나머지 단계는 지움 */
  saveVoiceBriefing(alarmId: string, value: VoiceBriefingSave): Promise<void>;
  /** 폰에 있는 음성의 열쇠 (서버에 have로 보내 같은 음성을 다시 안 만들게) */
  getVoiceBriefingHashes(alarmId: string): Promise<string[]>;
  clearVoiceBriefing(alarmId: string): Promise<void>;
  /** 백그라운드 브리핑 갱신용 기기 키 저장 · 정보 읽기(없으면 null) · 지우기 (#515) */
  setBriefingDevice(value: BriefingDeviceKey): Promise<void>;
  getBriefingDevice(): Promise<BriefingDeviceInfo | null>;
  clearBriefingDevice(): Promise<void>;
};
