// ① 약속 기반 알람 — 이 기능에서 쓰는 타입
// 이름은 DB(supabase/migrations · src/types/database.ts)를 따르고, 화면에 바로 쓰기 좋게 모양만 바꿈
import type { Weekday } from '@/lib/weekday';
import type { Enums } from '@/types/database';

import type { TravelProblem } from './travelConfirm';

export type AlarmKind = Exclude<Enums<'alarm_type'>, 'ROUTINE'>; // 기상 · 준비 · 출발 · 도착
export type Importance = Enums<'importance_level'>;
export type Transport = Enums<'transport_type'>;
export type Level = 0 | 1 | 2; // 약 · 중 · 강 — 화면에서 LEVELS 칸을 고를 때 씀
export type AlarmIntensity = Enums<'alarm_intensity'>; // DB · 알람 코어 값

const INTENSITY_OF: readonly AlarmIntensity[] = ['SOFT', 'NORMAL', 'STRONG'];
export const toAlarmIntensity = (level: Level): AlarmIntensity => INTENSITY_OF[level];
export const toLevel = (intensity: AlarmIntensity) => INTENSITY_OF.indexOf(intensity) as Level;
export type IntensityAxis = 'sound' | 'voice' | 'vibration'; // 배경음 · 말소리 · 진동

export const KIND_LABEL: Record<AlarmKind, string> = { WAKE: '기상', PREPARE: '준비', DEPARTURE: '출발', ARRIVE: '도착' };

// 새 일정(H05)에서 고르는 알람 종류 — 도착은 울리는 알람이 아니라 목표 시각이라 고르지 않음 (D46)
export const RING_KINDS: readonly RingKind[] = ['WAKE', 'PREPARE', 'DEPARTURE'];
export const defaultAlarms = (): Record<RingKind, boolean> => ({ WAKE: true, PREPARE: true, DEPARTURE: true });

// 목업의 보통 · 중요 · 매우 중요 = DB LOW · NORMAL · HIGH
export const IMPORTANCE_LABEL: Record<Importance, string> = { LOW: '보통', NORMAL: '중요', HIGH: '매우 중요' };
export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 1, HIGH: 2 };

// 출발 위치 기본값 · 이동 수단 고르기 (H05 · H03) — DB에는 BUS · SUBWAY도 있지만 목업 선택지는 이 셋
export const ORIGIN_HOME = '집';

export const TRANSPORT_LABEL: Record<Transport, string> = {
  TRANSIT: '대중교통',
  BUS: '버스',
  SUBWAY: '지하철',
  CAR: '자차',
  WALK: '도보',
};

export const TRANSPORT_OPTIONS: readonly (readonly [Transport, string])[] = (['TRANSIT', 'CAR', 'WALK'] as const).map((t) => [t, TRANSPORT_LABEL[t]] as const);

export const LEVELS: readonly { name: string; sound: string; voice: string; vibration: string }[] = [
  { name: '약', sound: '60% · 부드러운 소리', voice: '차분 · 다정', vibration: '없음' },
  { name: '중', sound: '80% · 기본 소리', voice: '일정 안내형', vibration: '짧게 반복' },
  { name: '강', sound: '100% · 강한 소리', voice: '직설형', vibration: '강하게 연속' },
];

export const AXES: readonly (readonly [IntensityAxis, string])[] = [
  ['sound', '배경음'],
  ['voice', '말소리'],
  ['vibration', '진동'],
];

export type AlarmTime = {
  id: string; // 알람 id (DB alarms.alarm_id) — 목업은 `${일정 id}:${종류}`
  kind: AlarmKind;
  at: Date;
  enabled: boolean; // 종류별로 끈 알람 (도착은 목표 시각이라 항상 true)
  auto?: Date; // 직접 고른 시각이면 자동 계산값 — "자동으로 되돌리기" · 고친 값 기록에 씀. 없으면 자동 계산 그대로 (D42 C)
};

// 예상 이동을 직접 입력했을 때의 출처 글자 (DB travel_source = MANUAL)
export const MANUAL_SOURCE = '직접 입력';

export type Appointment = {
  id: string;
  title: string;
  at: Date; // 약속 시각
  place: string;
  origin: string; // 출발 위치
  transport: Transport;
  travelMinutes: number;
  travelSource: string; // 예상 이동의 근거 (길찾기 + 내 실측 3회)
  bufferMinutes: number; // 여유
  beforePrepMinutes: number; // 준비 전 활동 — 기상 뒤 준비 알람까지
  prepMinutes: number; // 실제 준비
  predictedPrepMinutes: number; // 예측 준비 (공통 P80 + 개인 보정)
  importance: Importance;
  repeatLabel: string; // 반복 없음 · 매일 · 평일 · 매주 월 · 수 (repeat.ts repeatLabel)
  recurrenceRule: string | null; // 반복 규칙 RRULE (appointments.recurrence_rule) — 없으면 반복 없음
  groupName: string | null; // 같이 가는 그룹 (공유 알람)
  items: string[]; // 준비물
  withWake: boolean; // 그날 첫 일정이라 기상 알람이 있음
  enabled: boolean; // 이 일정의 알람 전체 켜기
  alarms: AlarmTime[]; // 기상 · 준비 · 출발 · 도착 목표 순 — H05에서 고른 종류만, 하나도 없으면 빈 목록(알람 없는 일정)
  level: Level; // 지금 적용되는 강도 (배경음 기준)
  standalone?: true; // 일정 없는 알람 (실데이터 전용, D46) — id는 알람 id, 제목은 "알람". 알람 설정(H03)은 아직 못 엶
};

// 하루 일정 한 줄 (H01) — 알람 없는 일정도 일정이라 id가 있음. 알람 없는 줄은 누를 수 없음 (일정 수정 · 삭제는 D41이 정함)
export type ScheduleItem = {
  appointmentId: string;
  at: Date;
  title: string;
  place: string;
  importance: Importance;
  hasAlarm: boolean; // 알람이 하나라도 있는 일정 — 없으면 H05에서 알람을 모두 끄고 저장한 일정
};

export type Intensity = {
  auto: Level; // 중요도 + 최근 4주 늦잠 지각으로 정한 값
  importancePoint: number;
  lateCount: number; // 최근 4주 늦잠 지각 횟수
  latePoint: number; // 2회 이상이면 1
  axes: Record<IntensityAxis, { level: Level; manual: boolean }>; // manual = 직접 고름
};

// 알람 설정(H03)에서 직접 고칠 수 있는 값 (D42 C) — 저장 전에는 화면이 초안으로 들고 있음
// 직접 고른 값(숫자 · 시각)은 자동 계산보다 먼저 쓰이고(강도와 같은 규칙), null · 없음이면 자동
export type AlarmEdits = {
  bufferMinutes: number; // 여유 (appointment_participants.buffer_minutes)
  origin: string; // 출발 위치 (origin_name)
  transport: Transport; // 이동 수단 (transport_type)
  travelMinutes: number | null; // 직접 입력한 예상 이동 (est_travel_minutes, 출처 MANUAL) — null = 길찾기 자동
  prepareMinutes: number | null; // 직접 고른 준비 시간 (prepare_minutes) — null = 공통 P80 + 개인 보정 자동
  times: Partial<Record<RingKind, Date>>; // 직접 고른 알람 시각 (alarms.scheduled_at) — 없는 종류는 자동
};

export type AppointmentDetail = Appointment & {
  intensity: Intensity;
  edits: AlarmEdits; // 지금 저장된 값 (초안의 처음 모양 · 바뀐 곳 비교)
  auto: { travelMinutes: number; predictedPrepMinutes: number }; // 직접 고른 값이 없을 때의 자동 계산값
};

// 값을 바꿔 보았을 때의 알람 (H03 저장 전 미리 보기) — 실데이터는 alarm-suggest
export type AlarmPreview = {
  alarms: AlarmTime[];
  travelMinutes: number; // 적용될 예상 이동 (직접 입력했으면 그 값)
  travelSource: string;
  autoTravelMinutes: number; // 출발 위치 · 이동 수단으로 다시 계산한 자동값
  predictedPrepMinutes: number; // 적용될 준비 시간
  autoPredictedPrepMinutes: number;
  // 실데이터 전용 — 길찾기를 못 해 저장하면 이동시간 확인이 필요한 상태 (ESTIMATE = 직선거리 어림, CACHED = 내 지난 이동 중앙값) 또는 직접 입력이 필요한 상태 (좌표 없음). 없으면 문제 없음
  travelProblem?: TravelProblem;
};

// 알람 설정(H03)에서 저장 전까지 들고 있는 값 — 저장할 때 한 번에 반영
export type AlarmSettingsDraft = AlarmEdits & {
  kinds: Partial<Record<AlarmKind, boolean>>; // 종류별 켜기 (기상 · 준비 · 출발)
  levels: Record<IntensityAxis, Level | null>; // null = 자동
};

export type NextAlarm = { appointment: Appointment; alarm: AlarmTime };

// 미룬 알람 (H01) — 다시 울릴 때까지 홈에 보이고 취소할 수 있음
export type Snooze = { alarmId: string; kind: RingKind; appointmentTitle: string; at: Date; minutes: number };

// 미루기 취소의 결과 — wakeCheck = 기상 알람의 미루기를 취소해 해제로 기록했으니 기상 확인(H08)으로 이어가야 함 (실데이터만, 가짜 데이터는 늘 false)
export type CancelSnoozeResult = { wakeCheck: boolean };

// 위도 · 경도 (장소 검색의 기준점 등)
export type LatLng = { lat: number; lng: number };

// 장소 — 가짜 데이터는 이름 + 집 기준 이동시간(검색용 주소 · 좌표도 있지만 계산엔 안 씀), 실데이터(place-search)는 이름 + 주소 + 좌표 (좌표가 있어야 길찾기가 됨)
//   category = 카카오 category_name 그대로('교육,학문 > 대학교') — 서버가 주는 값을 통과시킬 뿐 DB에 저장하지 않음 (D5)
export type Place = { name: string; travelMinutes?: number; address?: string; lat?: number; lng?: number; category?: string };

// 새 일정 입력값 (H05)
export type AppointmentDraft = {
  title: string;
  date: Date; // 날짜 (시각은 time)
  time: string; // 14:00
  repeat: Weekday[]; // 반복 요일 (월요일부터) — 비어 있으면 반복 없음. 저장할 때는 RRULE (repeat.ts)
  place: string;
  placeLat?: number; // 고른 장소의 좌표 (place-search) — 가짜 데이터 계산은 안 읽음. 없으면 listPlaces가 기억해 둔 이름 → 좌표를 씀
  placeLng?: number;
  transport: Transport;
  importance: Importance;
  items: string; // 쉼표로 구분
  alarms: Record<RingKind, boolean>; // 만들 알람 종류 (D46) — 모두 끄면 알람 없는 일정
};

// 새 일정 알람 계산 결과 (H05 확인 시트) — 실데이터는 alarm-suggest Edge Function
export type Estimate = {
  appointment: Appointment; // 아직 저장 전
  commonP80: number; // 공통 P80 (분)
  correction: number; // 개인 보정 (분)
  sampleCount: number; // 내 기록 수 n
  prior: number; // k
  weight: number; // n / (n + k)
  residualP80: number; // 개인 오차 P80 (분)
  sameDayWake: boolean; // 같은 날 앞선 일정에 기상 알람이 있어 외출 준비만
  latePoint: number; // 최근 4주 늦잠 지각 점수 (강도 계산)
  // 실데이터 전용 — 서버가 계산한 이동시간의 근거 한 줄 ("길찾기 기준" · "대략적인 값이에요 · 확인이 필요해요")과 확인 필요 여부. 없으면 목업 문구
  travelNote?: string;
  travelNeedsConfirm?: boolean;
  // 실데이터 전용 — 저장(alarm-commit)에 그대로 쓸 요청 조각. 화면은 읽지 않고 adjustEstimate가 펼쳐서 넘기기만 함
  commit?: EstimateCommit;
};

// 확인 시트에서 보여 준 값을 그대로 저장하려고 들고 가는 것 — alarm-suggest에 보낸 요청(appointment · participant · kinds)과 서버가 돌려준 이동 출처
export type EstimateCommit = {
  body: Record<string, unknown>;
  travelSource: 'API' | 'MANUAL' | 'CACHED' | 'ESTIMATE';
};

// 울림 화면 (H07) — 실제 울림은 알람 코어(네이티브)
export type RingKind = Exclude<AlarmKind, 'ARRIVE'>;

export type RingInfo = {
  alarmId: string;
  kind: RingKind;
  appointment: Appointment;
  at: Date; // 울리는 시각
  voiceTone: string; // 말소리 강도 설명
  voiceLine: string; // 음성 안내 문장
  levelLine: string; // 알람 강도 중 · 배경음 80% · 진동 짧게 반복
  important: boolean;
};

// 기상 판정 단계 (목업 S.wake.phase + 기상 알람 울림) — 울림 → 해제 뒤 관찰 → 확인 알림 → 확정
export type WakePhase = 'idle' | 'ringing' | 'observing' | 'prompt' | 'confirmed';
export const WAKE_OBSERVE_MINUTES = 10; // 해제 뒤 화면 사용을 보는 시간 — 끝나면 확정 또는 확인 알림
export const WAKE_RECENT_MINUTES = 5; // 최근 사용을 보는 관찰 뒤쪽 시간 (해제 뒤 5~10분)
export const WAKE_NO_REPLY_MINUTES = 5; // 확인 알림에 응답이 없으면 이만큼 뒤 기상 알람이 다시 울림

// 기상 확인 (H08) — 기상 알람 하나 기준 (alarm_events.alarm_id에 WAKE_CONFIRMED)
export type WakeCheck = {
  alarmId: string;
  appointmentTitle: string;
  groupId: string | null; // 기상 완료를 알려 줄 그룹 — 없으면 공유 안내 · 그룹 버튼을 숨김
  groupName: string | null;
  phase: 'observing' | 'prompt'; // 확정 전 단계 (확정이면 confirmed)
  dismissedAt: Date; // 기상 알람을 실제로 끈 시각 (다시 울린 뒤 끄면 그 시각)
  thetaMinutes: number; // 기상 판정 기준 θ — 해제 뒤 10분 동안 누적 화면 사용
  usage: number; // 누적 사용 · 해제 후 10분 (분) — 지금은 시연 값, 실데이터는 #35 · #40
  recent: number; // 최근 사용 · 뒤쪽 5분 (분)
  confirmed: { at: Date; how: 'self' | 'auto' } | null; // 이미 확정했으면
};

// 고친 값 기록 (고치기 원칙) — 사용자가 자동 값을 직접 고치면 하나씩 남겨 두고, 나중에 개인화(계산 · 제안)에 씀
// DB public.user_edit_logs 한 줄과 같은 모양 — 실데이터가 붙으면 api.ts의 recordEdit만 insert로 바뀜
//   screen: 고친 화면 (S01 = 알람 조정 제안 직접 수정, 다른 담당이 같은 기록 함수를 부름)
//   autoValue: 고치기 전에 앱이 쓰던 값 — 계산하는 값(이동 · 준비 · 알람 시각 · 강도)은 자동 계산값, 입력하는 값(여유 · 출발 위치 · 이동 수단 · 켜기)은 고치기 전 값
//   editedValue: 고친 뒤 값. 자동으로 되돌렸으면 null
//   강도 세 칸은 DB 칸 이름으로 남김 — 배경음 = sound_key, 말소리 = voice_tone, 진동 = intensity (값은 약 · 중 · 강 = 0 · 1 · 2)
export type EditLogScreen = 'H03' | 'H05' | 'S01';
export type EditLogField =
  | 'buffer_minutes'
  | 'prepare_minutes'
  | 'travel_minutes'
  | 'origin'
  | 'transport'
  | 'intensity'
  | 'voice_tone'
  | 'sound_key'
  | 'alarm_enabled'
  | 'scheduled_at';

export type UserEditLog = {
  at: Date;
  screen: EditLogScreen;
  field: EditLogField;
  appointmentId?: string;
  alarmId?: string;
  alarmType?: AlarmKind;
  autoValue: unknown;
  editedValue: unknown;
};
