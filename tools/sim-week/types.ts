// 하네스 공용 타입. 팀 레포 L1 · L2 타입은 쓰는 쪽에서 느슨하게(any 없이 필요한 모양만) 받음 — bridge.ts 로 동적으로 불러서 타입 선언이 없음
export type Importance = 'LOW' | 'NORMAL' | 'HIGH';
export type Transport = 'WALK' | 'TRANSIT' | 'BUS' | 'SUBWAY' | 'CAR';
export type RingKind = 'WAKE' | 'PREPARE' | 'DEPARTURE';
export type Level = 0 | 1 | 2;

export type SituationId = 'CONVENIENCE' | 'JOG' | 'RETURN' | 'NEAR' | 'CAMPUS' | 'SUBWAY_DUP';

// ---- 사람 (ai-lab data/personas.json + v3 말투 · 습관) ----
export interface Persona {
  id: string;
  split: 'dev';
  name: string;
  age: number;
  major: string;
  living: string;
  transport: Transport;
  travel_minutes: number;
  prep_minutes: number;
  buffer_minutes: number;
  chronotype: 'EARLY' | 'NORMAL' | 'LATE';
  sleep_pattern: string;
  snooze_tendency: number;
  talkativeness: 'TERSE' | 'NORMAL' | 'CHATTY';
  style: 'POLITE' | 'CASUAL' | 'TYPO_SLANG' | 'STT';
  mood_baseline: number;
  correction_tendency: 'ACCEPT' | 'CORRECT' | 'DENY' | 'ADD_INFO';
  cooperation: 'LOW' | 'MID' | 'HIGH';
  weekly: { weekday: string; title: string; time: string; place: string; importance: Importance; kind: string }[];
  recurring_reasons: { tag: string; weekdays: string[]; extra_minutes: number }[];
  bio: string;
  speech?: { register: 'POLITE' | 'HALF' | 'BANMAL'; description: string; fillers: string[]; habits: string[]; self_correct: 'NEVER' | 'SOMETIMES' | 'OFTEN' };
  flow?: {
    wake: { habit: string; first_unlock_delay: [number, number]; lie_phone_min: [number, number]; lie_phone_long: { weekdays: string[]; min: [number, number] } | null; resleep_prob: number; resleep_min: [number, number]; awake_before_min: [number, number]; auto_confirm_prob: number };
    depart: { from_label: string; exit_walk_min: [number, number]; trip: { kind: string; prob: number; minutes: [number, number] } | null };
    travel: { route_label: string; api_estimate_min: number; walk_to_station_min: number; sd: number; weekday_extra: Record<string, number>; rain_extra: number; incidents: { kind: string; prob: number; minutes: [number, number] }[] };
    arrival: { dest_label: string; walk_to_dest_min: number };
    prep: { pre_prep_gap_min: [number, number]; skip_when_late: string[] };
    conversation: { tap_prob: number };
  };
}

// ---- 세계 ----
export interface Place {
  name: string;
  shortName?: string;
  lat: number;
  lng: number;
  category: string | null;
  kind: 'CAMPUS' | 'AREA' | 'WIDE' | 'BUILDING' | 'UNKNOWN';
  radiusM: number;
}

export interface WorldAppt {
  id: string;
  day: number;
  date: string;
  time: string;
  at: Date;
  title: string;
  place: Place;
  importance: Importance | null; // 진짜 중요도 (null = 본인도 정해 두지 않음)
  transport: Transport;
  travelMinutes: number; // 진짜 평소 이동
  repeat: 'NONE' | 'WEEKLY';
  buildingOffsetM: number;
  synthetic: boolean; // 시험이 만든 일정 (NEAR 상황)
}

export interface WorldDay {
  personaId: string;
  day: number; // 1~7
  date: string;
  weekday: string;
  appts: WorldAppt[];
  home: Place;
  situation: SituationId | null;
  naturalWake: Date; // 알람이 없을 때의 기상
  labWake: string; // 실험실 타임라인의 그날 기상 (참고)
}

// ---- 앱이 아는 것 ----
export interface AlarmSummary {
  kind: RingKind | 'ARRIVE';
  at: Date;
  enabled: boolean;
  manual: boolean; // 직접 고른 시각
}

export interface PlanSummary {
  apptId: string;
  alarms: AlarmSummary[];
  level: Level; // 대표 강도
  levelReason: string;
  wakeAt: Date | null;
  departAt: Date;
  prepareMinutes: number;
  prepareSource: string; // DEFAULT · PERSONAL · MANUAL
  prepareBasis: { common: number; correction: number; n: number; weight: number };
  travelMinutes: number;
  travelSource: string; // API · CACHED · ESTIMATE · MANUAL
  withWake: boolean;
  checkOk: boolean;
  checkMessage: string | null;
}

export interface AppAppt {
  id: string; // 앱 안의 약속 번호 (a1…)
  worldId: string | null; // 어느 진짜 약속과 맞물리는지 (시험이 채움, 앱은 모름)
  title: string;
  date: string;
  time: string;
  at: Date;
  dest: Place | null;
  importance: Importance;
  importanceSource: 'SAID' | 'KEYWORD' | 'DEFAULT';
  transport: Transport;
  bufferMinutes: number;
  overrides: { manualTimes?: Partial<Record<RingKind, Date>>; levels?: Partial<Record<'sound' | 'voice' | 'vibration', Level>>; prepareMinutes?: number; travelMinutes?: number; enabled?: Partial<Record<RingKind, boolean>> };
  items: string[];
  plan: PlanSummary | null;
  saved: boolean;
  savedVia: string | null;
}

// ---- 하루 기록 ----
export type TimeSource = 'LOCATION' | 'BUTTON' | 'MANUAL';

export interface TripRecord {
  apptId: string; // 진짜 약속 번호
  title: string;
  apptAt: string; // ISO
  trueDepart: string | null; // 진짜 현관 출발
  trueArrive: string | null;
  trueLateMin: number; // 진짜 지각 분 (약속 − 도착, 음수면 일찍)
  trulyLate: boolean; // 진짜 지각 (+5분 넘음)
  recordedDepart: string | null; // 앱 기록
  departSource: TimeSource | null;
  recordedArrive: string | null;
  arriveSource: TimeSource | null;
  isLate: boolean | null; // 앱 판정 (null = 보류)
  lateMinutes: number | null;
  near: boolean;
  signals: { regionId: string; type: 'ENTER' | 'EXIT'; at: string; label: string }[];
  actions: { type: string; at: string }[];
  misjudge: string[]; // 오판 이름들
  oneTap: string[]; // 원탭이 필요했던 일
  alarmWake: string | null;
  note: string[];
}

export interface DayRecord {
  personaId: string;
  day: number;
  date: string;
  weekday: string;
  situation: SituationId | null;
  alarmWakeAt: string | null; // 그날 첫 기상 알람 (없으면 null)
  alarmLevel: Level | null;
  alarmOk: boolean; // 알람이 있었는지
  snoozes: number;
  getUpAt: string; // 진짜 일어난 시각
  wakeRecordedAt: string | null; // 앱 기록
  wakeSource: 'USAGE' | 'BUTTON' | null;
  wakeConfirmed: boolean;
  prepActual: number; // 진짜 준비 분 (일어나서 출발까지)
  actualPrepareMinutes: number | null; // 앱 학습 기록 (출발 − 기상)
  trips: TripRecord[];
  late: boolean; // 진짜 지각이 하나라도
  appLate: boolean; // 앱이 지각이라 본 것이 하나라도 (보류 제외)
  oneTapCount: number;
  misjudgeCount: number;
}
