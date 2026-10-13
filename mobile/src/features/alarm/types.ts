// ① 약속 기반 알람 — 이 기능에서 쓰는 타입
// 이름은 DB(supabase/migrations · src/types/database.ts)를 따르고, 화면에 바로 쓰기 좋게 모양만 바꿈
import type { Enums } from '@/types/database';

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

// 목업의 보통 · 중요 · 매우 중요 = DB LOW · NORMAL · HIGH
export const IMPORTANCE_LABEL: Record<Importance, string> = { LOW: '보통', NORMAL: '중요', HIGH: '매우 중요' };
export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 1, HIGH: 2 };

export const TRANSPORT_LABEL: Record<Transport, string> = {
  TRANSIT: '대중교통',
  BUS: '버스',
  SUBWAY: '지하철',
  CAR: '자차',
  WALK: '도보',
};

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
};

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
  repeatLabel: string;
  groupName: string | null; // 같이 가는 그룹 (공유 알람)
  items: string[]; // 준비물
  withWake: boolean; // 그날 첫 일정이라 기상 알람이 있음
  enabled: boolean; // 이 일정의 알람 전체 켜기
  alarms: AlarmTime[]; // 기상 · 준비 · 출발 · 도착 목표, 시각 순
  level: Level; // 지금 적용되는 강도 (배경음 기준)
};

export type ScheduleItem = {
  appointmentId: string | null; // 알람 없는 일정이면 null
  at: Date;
  title: string;
  place: string | null;
  importance: Importance | null;
};

export type Intensity = {
  auto: Level; // 중요도 + 최근 4주 늦잠 지각으로 정한 값
  importancePoint: number;
  lateCount: number; // 최근 4주 늦잠 지각 횟수
  latePoint: number; // 2회 이상이면 1
  axes: Record<IntensityAxis, { level: Level; manual: boolean }>; // manual = 직접 고름
};

export type AppointmentDetail = Appointment & { intensity: Intensity };

export type NextAlarm = { appointment: Appointment; alarm: AlarmTime };

export type Place = { name: string; travelMinutes: number };

// 새 일정 입력값 (H05)
export type AppointmentDraft = {
  title: string;
  date: Date; // 날짜 (시각은 time)
  time: string; // 14:00
  repeat: 'NONE' | 'WEEKLY';
  place: string;
  transport: Transport;
  importance: Importance;
  items: string; // 쉼표로 구분
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
