// ① 약속 기반 알람 — 이 기능에서 쓰는 타입
// 이름은 DB(supabase/migrations · src/types/database.ts)를 따르고, 화면에 바로 쓰기 좋게 모양만 바꿈
import type { Weekday } from '@/lib/weekday';
import type { Enums } from '@/types/database';
import type { DepartStatus } from '@shared/calc/depart.ts';

import type { AlarmChange } from './schedule';
import type { TravelProblem } from './travelConfirm';

export type { AlarmChange }; // 저장하면 시각이 바뀌는 알람 한 줄 { kind, from, to } — 정의는 schedule.ts (H03 확인 시트와 같은 것)

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

// 화면 글자 평소 · 중요 · 매우 중요 = DB LOW · NORMAL · HIGH (강도 이름 약 · 보통 · 강과 안 겹치게 '보통'을 '평소'로, 10/30)
export const IMPORTANCE_LABEL: Record<Importance, string> = { LOW: '평소', NORMAL: '중요', HIGH: '매우 중요' };
// 중요도로 올리는 단계 수 — 매우 중요(HIGH)만 1 (D69, 공용 IMPORTANCE_POINT와 같아야 함: mocks/__tests__/shared.test.ts)
export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 0, HIGH: 1 };

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

// 약 · 중 · 강 한 단계가 가리키는 것 (D1 A, 실제 동작과 같게):
//   volume    전체 세기(alarms.intensity)가 정하는 알람 볼륨 — 배경음 축을 따로 골라도 안 바뀜 (알람 코어 BASE_VOLUME_PERCENT)
//   sound     배경음 축 = 소리 파일 (sound_key theme_calm · theme_default · theme_urgent)
//   voice     말소리 축 = 기상 알람 음성 문장의 말투 (voice_tone CALM · NEUTRAL · DIRECT, 읽어 주는 것은 D8 · 나중)
//   vibration 진동 축 = 진동 패턴 (alarms.vibration NONE · SHORT_REPEAT · STRONG_CONTINUOUS)
export const LEVELS: readonly { name: string; volume: string; sound: string; voice: string; vibration: string }[] = [
  { name: '약', volume: '60%', sound: '부드러운 소리', voice: '차분 · 다정', vibration: '없음' },
  { name: '중', volume: '80%', sound: '기본 소리', voice: '일정 안내형', vibration: '짧게 반복' },
  { name: '강', volume: '100%', sound: '강한 소리', voice: '직설형', vibration: '강하게 연속' },
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
  placeLat?: number; // 장소 좌표(DB dest_lat · dest_lng) — 실데이터 H03만 채움. 편집 시트가 장소를 바꾼 뒤 되돌리기에 원래 좌표를 같이 보내려고 씀 (#275)
  placeLng?: number;
  canEdit?: false; // 남이 만든 공동 약속이라 고치거나 지울 수 없음 (N6, H03 편집 시트가 읽기 전용으로 열림). 없으면 고칠 수 있음
  upcomingCount?: number; // 같은 반복 묶음에서 지금 이후 남은 회차 수(이 회차 포함) — 알람 목록(H02)만 채움. 2 이상이면 앞으로 회차가 폰에 미리 걸려 있음
};

// 저장(alarm-commit)은 됐는데 그 뒤처리가 못 한 것 — 화면은 원래 저장 문구 대신 saveNotice.ts 문구로 알림. 다 됐으면 followUp 없음
//   phoneFailed = 폰에 못 건 알람 수 (다음 맞추기에서 다시 걸리고, 그때까지 홈 빨간 줄에 남음)
//   itemsFailed = 준비물(todos)을 못 넣음 (다시 넣는 길이 없음)
export type SaveFollowUp = { phoneFailed: number; itemsFailed: boolean };

// 공동 약속 [내 알람 만들기] 확인 시트 (친구 9장) — 출발지는 내 집, 수단 · 준비 시간 기본값은 프로필(온보딩 값), 시트에서 고침
export type JoinDefaults = { homeName: string | null; transport: Transport; prepareMinutes: number };
// prepareMinutes null = 기본값 그대로(서버가 내 기록으로 계산). travelMinutes = 길찾기를 못 해 사용자가 확인한 이동시간(MANUAL), 보통은 없음(서버가 길찾기)
export type JoinChoice = { transport: Transport; prepareMinutes: number | null; travelMinutes?: number | null };
export type JoinResult = { phoneFailed: number }; // 폰에 못 건 알람 수
export type SavedAppointment = Appointment & { followUp?: SaveFollowUp };
export type SettingsSaveResult = { turnedOff: boolean; turnedOn: boolean; followUp?: SaveFollowUp };

// 반복 일정의 앞으로 회차 한 줄 (H03 회차 목록) — 같은 묶음(series_id)의 지금 이후 회차, 시각 순
export type Occurrence = {
  id: string; // 약속 id (실데이터는 appointment_id)
  at: Date; // 약속 시각
  alarmAt: Date | null; // 이 회차에서 가장 먼저 울릴 켜진 알람 시각(기상 · 준비 · 출발). 알람이 없거나 다 껐으면 null
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
  auto: Level; // 기본 보통 + 중요도(매우 중요) · 최근 4주 늦잠 지각으로 올린 값 (D69)
  voiceAuto: Level; // 말소리를 직접 안 골랐을 때 값 — 설정의 기본 말소리(profiles.preferred_voice_tone), 없으면 auto
  importancePoint: number; // 중요도로 올린 단계 (매우 중요면 1)
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

// 일정 수정 · 삭제 (H03 편집 시트, 이슈 #211 · D41 A · N6) — 고칠 수 있는 값. 안 넣은 칸은 그대로
//   at = 약속 날짜 · 시각, place = 장소 이름(H05와 같은 글자), repeatDays = 반복 요일(빈 목록 = 반복 없음). 반복 요일은 scope가 'following'일 때만 먹음
export type AppointmentPatch = {
  title?: string;
  at?: Date;
  place?: string;
  placeLat?: number; // 고른 장소의 좌표 (place-search) — 실서버(4b)가 길찾기를 새로 구하는 데 씀. 가짜 모드는 안 읽음 (AppointmentDraft와 같음)
  placeLng?: number;
  importance?: Importance;
  repeatDays?: Weekday[];
};

// 반복 일정의 고치기 · 지우기 범위 — this = 이번 회차만, following = 이번 회차와 그 뒤 모두. 반복이 아니면 둘 다 그 일정 하나
export type EditScope = 'this' | 'following';

// updateAppointment 결과 — changes = 바뀌는 알람의 전 → 후(시각이 바뀌는 기상 · 준비 · 출발만, 도착 목표는 안 셈),
//   needsConfirm = 늦춰지는 알람이 있어 확인이 먼저인 상태. true면 아직 저장하지 않았음 (D67): 확인 시트 → { confirmed: true }로 다시 부름
export type UpdateResult = { changes: AlarmChange[]; needsConfirm: boolean };
export type UpdateOptions = {
  confirmed?: boolean; // 확인 시트에서 "바꾸기"를 눌렀거나, 되돌리기처럼 확인 없이 바로 저장할 때
};

// 값을 바꿔 보았을 때의 알람 (H03 저장 전 미리 보기) — 실데이터는 alarm-suggest
export type AlarmPreview = {
  alarms: AlarmTime[];
  travelMinutes: number; // 적용될 예상 이동 (직접 입력했으면 그 값)
  travelSource: string;
  autoTravelMinutes: number; // 출발 위치 · 이동 수단으로 다시 계산한 자동값
  predictedPrepMinutes: number; // 적용될 준비 시간
  autoPredictedPrepMinutes: number;
  prepareSampleCount?: number; // 준비 시간 계산에 쓴 내 기록 수 (최근 30건 기준) — "배우는 중 N/5" · "내 기록 기반 N건" 한 줄에 (calc prepareSourceLabel). 모르면 없음
  prepareRecent?: number[]; // 준비 시간 계산에 쓴 내 기록 중 최근 값, 최신순 최대 5개(분) — "최근 5번 48 · 55 · 62 · 70 · 75분" 줄 (calc prepareRecentLabel). 없거나 비면 줄을 안 보임
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

// 지도 핀 자리의 주소 (place-reverse) — 주소 한 줄(도로명 우선) + 있으면 건물 이름. 화면에 보일 뿐 저장하지 않음 (카카오 응답, D5)
export type PinAddress = { address: string; name?: string };

// 새 일정 입력값 (H05)
export type AppointmentDraft = {
  title: string;
  date: Date; // 날짜 (시각은 time)
  time: string; // 14:00
  repeat: Weekday[]; // 반복 요일 (월요일부터) — 비어 있으면 반복 없음. 저장할 때는 RRULE (repeat.ts)
  place: string;
  placeLat?: number; // 고른 장소의 좌표 (place-search) — 가짜 데이터 계산은 안 읽음. 없으면 listPlaces가 기억해 둔 이름 → 좌표를 씀
  placeLng?: number;
  originLocation?: LatLng; // 이번 일정의 출발지로 사용자가 고른 현재 위치
  originName?: string; // 직접 검색한 출발지 이름. 현재 위치면 비움
  destRadiusM?: number; // 도착 감지 반경(m, 정수 100~500) — 지도 시트에서 고른 값. 없으면 서버 기본값 (요청 destination.radius_m, destinationPick.ts)
  transport: Transport;
  importance: Importance; // 제목에서 자동 판단. 일정 생성 화면에서는 직접 고르지 않음
  levels?: Record<IntensityAxis, Level | null>; // H05 알람 세 축(배경음·말소리·진동), null=자동
  items: string; // 쉼표로 구분
  alarms: Record<RingKind, boolean>; // 만들 알람 종류 (D46) — 모두 끄면 알람 없는 일정
  groupId?: string | null; // 함께할 그룹 — 고르면 공동 약속 (친구 9장, 요청 appointment.group_id). 없으면 개인 일정
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
  levels?: Record<IntensityAxis, Level | null>; // 새 일정 화면에서 고른 축(목업에도 유지)
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
  notice?: string; // 알림 한 줄 — 준비 · 출발 알람이 알림 · 울림 화면 머리글로 보여 주는 글자 (서버 꾸러미 notice와 같은 글자, features/alarm/notice.ts). 없으면 종류별 기본 머리글
  levelLine: string; // 알람 강도 중 · 볼륨 80% · 배경음 기본 소리 · 진동 짧게 반복
  important: boolean;
  snoozeCount: number; // 이미 미룬 횟수 (알람 코어의 snoozeCount) — "미루기 N/한도회"
  snoozeLimit: number; // 미루기 한도 (알람 코어 RingPlan.snoozeLimit, 서버 alarms.snooze_limit 기본 3)
  departAt: Date | null; // 출발 시각 (꾸러미 departAt) — 한도 안내 · "이만큼 미루면 늦어요" 판단. 모르면 null
};

// 기상 판정 단계 (목업 S.wake.phase + 기상 알람 울림) — 울림 → 해제 뒤 관찰 → 확인 알림 → 확정
export type WakePhase = 'idle' | 'ringing' | 'observing' | 'prompt' | 'confirmed';
export const WAKE_OBSERVE_MINUTES = 10; // 해제 뒤 화면 사용을 보는 시간 — 끝나면 확정 또는 확인 알림
export const WAKE_RECENT_MINUTES = 5; // 최근 사용을 보는 관찰 뒤쪽 시간 (해제 뒤 5~10분)

// H08 [먼저 깼어요] — 알람이 울리기 전 이만큼 안에 깬 날만 (D61 '예정 기상 전 60분 안')
export const EARLY_WAKE_MINUTES = 60;
export type EarlyWake = { alarmId: string; at: Date }; // 곧 울릴 기상 알람과 그 시각

// 기상 확인 (H08) — 기상 알람 하나 기준 (alarm_events.alarm_id에 WAKE_CONFIRMED)
export type WakeCheck = {
  alarmId: string;
  appointmentTitle: string;
  groupId: string | null; // 기상 완료를 알려 줄 그룹 — 없으면 공유 안내 · 그룹 버튼을 숨김
  groupName: string | null;
  phase: 'observing' | 'prompt'; // 확정 전 단계 (확정이면 confirmed)
  dismissedAt: Date; // 기상 알람을 실제로 끈 시각 (미룬 뒤 다시 울려 끄면 그 시각)
  thetaMinutes: number; // 기상 판정 기준 θ — 해제 뒤 10분 동안 누적 화면 사용
  usage: number; // 누적 사용 · 해제 후 10분 (분) — 지금은 시연 값, 실데이터는 #35 · #40
  recent: number; // 최근 사용 · 뒤쪽 5분 (분)
  confirmed: { at: Date; how: 'self' | 'auto' } | null; // 이미 확정했으면
};

// 기상 후 아침 흐름 (이슈 #230) — H08(기상 확정 뒤) 한 줄과 홈 아침 카드(기상 알람 시각부터)가 읽는 "오늘 첫 일정"
// 오늘 첫 일정 = 그날 켜진 기상 알람이 붙은 약속 중 가장 이른 것 (서버 calc/wake.ts hasEarlierWake와 같은 기준). 저녁(18시~)에는 홈처럼 내일
// 준비 · 출발 · 도착 목표는 켜진 알람의 시각 — 꺼져 있거나 없으면 null
export type MorningPlan = {
  appointmentId: string;
  title: string;
  at: Date; // 약속 시각
  place: string;
  wakeAlarmId: string;
  wakeAt: Date; // 기상 알람 시각 — 홈 아침 카드가 이 시각부터 보임
  prepareAt: Date | null;
  departAt: Date | null;
  arriveAt: Date | null; // 도착 목표
  travelMinutes: number; // 저장된 예상 이동
  travelSource: string; // 예상 이동의 출처 글자 (길찾기 · 대략적인 값 · 직접 입력 …)
  wakeConfirmedAt: Date | null; // 이 기상 알람의 기상 확정 시각 — 없으면 아직 확정 전 (카드는 확정을 기다리지 않음)
  departedAt: Date | null; // 출발 기록 (appointment_participants.departed_at) — 있으면 이미 나선 것
  arrivedAt: Date | null; // 도착 기록 (appointment_participants.arrived_at) — 홈 '이동 중' · '도착했어요' 줄
};

// 지금 나가면 (홈 아침 카드 [다시 확인]) — 지금 + 이동 = 도착, 여유 · 상태는 서버와 같은 departNow (7장 7.5.2)
export type DepartCheck = {
  travelMinutes: number;
  source: string; // 이동 출처 글자
  arriveAt: Date;
  slackMinutes: number; // 약속 − 도착 (음수면 늦음)
  status: DepartStatus; // COMFORT 여유 · TIGHT 빠듯 · LATE_RISK 지각 위험
  checkedAt: Date; // 확인한 시각
};

// 고친 값 기록 (고치기 원칙) — 사용자가 자동 값을 직접 고치면 하나씩 남겨 두고, 나중에 개인화(계산 · 제안)에 씀
// DB public.user_edit_logs 한 줄과 같은 모양 — 실데이터가 붙으면 api.ts의 recordEdit만 insert로 바뀜
//   screen: 고친 화면 (S01 = 알람 조정 제안 직접 수정, 다른 담당이 같은 기록 함수를 부름)
//     H03 · H05 · S01은 저장(alarm-commit edits)과 같이 남김. H01 홈 감지 정정 줄 · NTF 감지 안내 알림 · H08 기상 정정(D61)은 앱이 user_edit_logs에 바로 남김
//   autoValue: 고치기 전에 앱이 쓰던 값 — 계산하는 값(이동 · 준비 · 알람 시각 · 강도)은 자동 계산값, 입력하는 값(여유 · 출발 위치 · 이동 수단 · 켜기)은 고치기 전 값
//   editedValue: 고친 뒤 값. 자동으로 되돌렸으면 null. 위치 감지를 [아니에요]로 지웠으면 { rejected: true } (features/location/detections.ts)
//   강도 세 칸은 DB 칸 이름으로 남김 — 배경음 = sound_key, 말소리 = voice_tone, 진동 = vibration (예전 기록은 intensity, 값은 약 · 중 · 강 = 0 · 1 · 2)
// alarm-commit이 받는 화면 (서버 supabase/functions/_shared/requests.ts SCREENS와 같음)
export type CommitEditScreen = 'H03' | 'H05' | 'S01';
export type EditLogScreen = CommitEditScreen | 'H01' | 'H08' | 'NTF';
export type EditLogField =
  | 'departed_at' // 위치로 잡은 출발 · 도착 정정 (H01 · NTF)
  | 'arrived_at'
  | 'buffer_minutes'
  | 'prepare_minutes'
  | 'travel_minutes'
  | 'origin'
  | 'transport'
  | 'intensity' // 예전 기록의 진동 (D1 A 전) — 지금은 쓰지 않음
  | 'vibration'
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
