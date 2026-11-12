// 알람 계산 공용 타입 · 상수 — Deno · Node · RN 어디서든 돌도록 프레임워크 API를 쓰지 않음 (Q4 A)
// 값 이름은 DB(alarm_type · importance_level · transport_type · alarm_intensity · voice_tone)와 같음
// 시각은 Date (앱의 목업 계산과 같은 모양). import는 상대 경로 + .ts, 타입은 import type으로

export type RingKind = 'WAKE' | 'PREPARE' | 'DEPARTURE';
export type AlarmKind = RingKind | 'ARRIVE';
export type Importance = 'LOW' | 'NORMAL' | 'HIGH';
export type Transport = 'WALK' | 'TRANSIT' | 'BUS' | 'SUBWAY' | 'CAR';
export type AlarmIntensity = 'SOFT' | 'NORMAL' | 'STRONG';
export type VoiceTone = 'CALM' | 'NEUTRAL' | 'DIRECT';
// 진동 — DB alarms.vibration 값 (text + check, 알람 코어 vibration 칸 값 이름과 같음). 약 NONE · 보통 SHORT_REPEAT · 강 STRONG_CONTINUOUS
export type AlarmVibration = 'NONE' | 'SHORT_REPEAT' | 'STRONG_CONTINUOUS';

// 약 · 중 · 강 (0 · 1 · 2)
export type Level = 0 | 1 | 2;
// 배경음 · 말소리 · 진동 — DB 칸: sound = sound_key, voice = voice_tone, vibration = vibration (intensity는 세 축이 아니라 "전체 세기" — 볼륨 · 다시 울림)
export type IntensityAxis = 'sound' | 'voice' | 'vibration';

export const RING_KINDS: readonly RingKind[] = ['WAKE', 'PREPARE', 'DEPARTURE'];
export const ALARM_KINDS: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
export const INTENSITY_AXES: readonly IntensityAxis[] = ['sound', 'voice', 'vibration'];

export const KIND_LABEL: Record<AlarmKind, string> = { WAKE: '기상', PREPARE: '준비', DEPARTURE: '출발', ARRIVE: '도착' };

// 알람 하나 — at이 쓰이는 시각, auto가 있으면 직접 고른 시각이고 auto는 자동 계산값 (D42 C "자동으로 되돌리기"용)
export type ChainAlarm = {
  kind: AlarmKind;
  at: Date;
  auto?: Date;
};

// 알람 역산 입력 (7장 7.1.1 + 목업 ALG-01)
export type ChainInput = {
  at: Date; // 약속 시각
  travelMinutes: number; // 적용되는 예상 이동 (직접 입력했으면 그 값)
  bufferMinutes: number; // 여유
  prepareMinutes: number; // 적용되는 준비 시간 = 기상 ~ 출발 (직접 고른 값 또는 P80 예측)
  beforePrepareMinutes: number; // 기상 뒤 준비 전 활동 — 0이면 기상 알람 뒤 준비 알람 없음
  withWake: boolean; // 그날 첫 일정이라 기상 알람이 있음
  kinds?: readonly RingKind[]; // 만든 알람 종류. 없으면 계산된 알람 전부, 빈 목록이면 알람 없는 일정
  manualTimes?: Partial<Record<RingKind, Date>>; // 직접 고른 알람 시각 (D42 C)
  prepareAdvanceMinutes?: number; // 받아들인 준비 알람 당김 분 (#484 · 안건 D111) — 준비 알람을 그만큼 앞당기고, 준비 전 활동을 넘는 만큼만 기상도 앞당김. 없으면 0
};
