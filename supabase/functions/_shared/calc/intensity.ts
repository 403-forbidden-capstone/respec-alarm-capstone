// ALG-02 알람 강도 — D56 1 기본안 → D69 (정한 것, 10/26: 기본 강도는 보통, 약은 사용자가 직접 고를 때만)
//   자동 = 보통(1)에서 시작해 올림 규칙을 단계로 더함, 상한 강(2). 중요도 낮음(LOW)이어도 기본은 보통(약으로 내려가지 않음)
//     · 중요도 매우 중요(HIGH)면 한 단계 올림 (보통 · 중요는 올림 없음)
//     · 최근 4주 늦잠 지각이 2회 이상이면 한 단계 올림
//     · 잠귀가 무거움(wakeSensitivity = HEAVY)이면 곧바로 강
//   직접 고른 칸(배경음 · 말소리 · 진동)이 있으면 그 칸은 그 값, 나머지는 자동 (약은 이 경우에만 나옴)
// 축별 고르기 (D1 A, 이슈 #312) — DB 칸 대응:
//   · alarms.intensity = "전체 세기"(볼륨 · 다시 울림). 늘 자동 단계(auto)가 들어감 — 직접 고른 축은 안 바꿈
//   · 배경음 축 → sound_key, 말소리 축 → voice_tone (자동이면 자동 단계 값이 들어감)
//   · 진동 축 → vibration. 직접 고른 값만 들어가고 자동이면 NULL(= 강도를 따름) — 폰 · 앱은 vibrationOf로 풀어 씀
//   직접 고른 축이 하나라도 있으면 intensity_source = MANUAL (규칙 그대로)
// 문서(7장 7.4.1 · 4장 정책표)와 다른 점은 D69를 따름:
//   · 문서: 중요도 낮음 → 늘 약 / 지금: 낮음도 기본 보통 (약은 직접 고를 때만)
//   · profiles.intensity_offset(수락한 제안 ±1)은 안 읽음 — 제안 적용은 D6 · D23~D25가 열려 있음
//   · "지각"은 appointment_participants.is_late 전체 — 7.4.1은 늦잠 원인(late_cause = WAKE)만 세므로, 그 칸이 생기면 좁힘
//   · 잠귀(profiles.wake_sensitivity: LIGHT · NORMAL · HEAVY)는 wakeSensitivityOf로 HEAVY만 HEAVY, 나머지는 NORMAL로 읽음 (가벼움도 기본 보통, 약은 직접 고를 때만).
//     plan-core · 앱 map.ts toIntensity · realWrite setIntensity · 가짜 모드(mocks/calc.ts) 네 곳이 같은 값을 넘김. 안 넘기면 NORMAL 취급
//   · 7.4.1 표의 theme_focus(HIGH · 지각 이력 없음)는 3단계(약 · 중 · 강)에 없어 안 씀
import type { AlarmIntensity, AlarmVibration, Importance, IntensityAxis, Level, VoiceTone } from './types.ts';

// 중요도로 올리는 단계 수 — 매우 중요(HIGH)만 1 (D69: 중요도는 한 단계 올릴지에만 씀). 앱 라벨 보통(LOW) · 중요(NORMAL) · 매우 중요(HIGH)
export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 0, HIGH: 1 };

// 가입 때 "잠귀" 한 문항 (D69). 계산에는 무거움(HEAVY)이냐 아니냐만 쓰므로 DB 값 LIGHT · NORMAL은 NORMAL로 묶음. 안 주면 NORMAL
export type WakeSensitivity = 'HEAVY' | 'NORMAL';

// DB 칸(profiles.wake_sensitivity 'LIGHT' | 'NORMAL' | 'HEAVY') → 계산에 넘기는 값. 모르는 값 · 빈 값은 NORMAL
//   L6 안건후보: 잠귀 모르는 값 기본안 = NORMAL (DB 제약이 LIGHT · NORMAL · HEAVY만 받으므로 실제로는 안 옴. 강으로 올리면 알람이 시끄러워지는 쪽이라 모르면 올리지 않음)
export function wakeSensitivityOf(value: string | null | undefined): WakeSensitivity {
  return value === 'HEAVY' ? 'HEAVY' : 'NORMAL';
}

// 축별 선택(배경음 · 말소리 · 진동을 따로 고름, D1 A)을 쓸지 — 앱 H03 선택 UI(lib/flags.ts ALARM_AXES_PICKER가 이 값을 다시 내보냄)와 서버 · 폰 계산이 같은 값을 봄.
//   false: 이미 저장된 축 값(sound_key · voice_tone · vibration)은 지우지 않되 **계산에서 무시**하고 모두 강도를 따름 — 숨긴 설정이 몰래 알람에 영향을 주지 않게 (헤드 확정 10/30).
//   다시 true로 켜면 저장돼 있던 값이 그대로 살아남. 결정 안건(투표) 결과 대기
//   서버 함수를 배포하는 쪽과 앱(APK 아님, JS)이 같은 값으로 올라가야 어긋나지 않음
export const AXES_PICKER_ENABLED = true;

// 기본 강도 = 보통 (D69)
export const BASE_LEVEL: Level = 1;
const MAX_LEVEL: Level = 2;

// 늦잠 지각이 이 횟수 이상이면 한 단계 올림 (7장 7.0.5 L_late = 2)
export const LATE_COUNT_THRESHOLD = 2;

// 단계 → DB 칸 값. 앱 LEVELS(약 '차분 · 다정' · 중 '일정 안내형' · 강 '직설형')와 7장 7.4.1 표의 톤 · 배경음 이름
//   vibration: 약 없음 · 중 짧게 반복 · 강 강하게 연속 (앱 LEVELS 진동 글자와 같은 순서)
export const LEVEL_FIELDS: readonly { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string; vibration: AlarmVibration }[] = [
  { intensity: 'SOFT', voiceTone: 'CALM', soundKey: 'theme_calm', vibration: 'NONE' },
  { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_default', vibration: 'SHORT_REPEAT' },
  { intensity: 'STRONG', voiceTone: 'DIRECT', soundKey: 'theme_urgent', vibration: 'STRONG_CONTINUOUS' },
];

// 기본 보통(1) + 중요도 올림 + 지각 올림, 잠귀가 무거우면 최대 — 상한 강(2)
export function autoLevel(importance: Importance, lateCount4w: number, wakeSensitivity?: WakeSensitivity): Level {
  if (wakeSensitivity === 'HEAVY') return MAX_LEVEL;
  const late = lateCount4w >= LATE_COUNT_THRESHOLD ? 1 : 0;
  return Math.min(MAX_LEVEL, BASE_LEVEL + IMPORTANCE_POINT[importance] + late) as Level;
}

export type IntensityOverrides = Partial<Record<IntensityAxis, Level | null>>;

export type ResolvedIntensity = {
  auto: Level; // 기본 보통 + 중요도 · 최근 4주 늦잠 지각 · 잠귀로 정한 값
  importancePoint: number; // 중요도로 올린 단계 (매우 중요면 1)
  lateCount: number;
  latePoint: number; // 2회 이상이면 1
  heavySleeper: boolean; // 잠귀가 무거워 강으로 올림
  axes: Record<IntensityAxis, { level: Level; manual: boolean }>;
  manual: boolean; // 한 칸이라도 직접 고름 → alarms.intensity_source = MANUAL
  // DB 칸 값: intensity = 전체 세기(자동 단계), voice_tone = 말소리 칸, sound_key = 배경음 칸,
  //   vibration = 진동 칸 — 직접 고른 값만, 자동이면 null(강도를 따름)
  fields: { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string; vibration: AlarmVibration | null };
};

export function resolveIntensity(
  importance: Importance,
  lateCount4w: number,
  overrides: IntensityOverrides = {},
  wakeSensitivity?: WakeSensitivity,
): ResolvedIntensity {
  const auto = autoLevel(importance, lateCount4w, wakeSensitivity);
  const axis = (a: IntensityAxis) => {
    const picked = overrides[a];
    return picked != null ? { level: picked, manual: true } : { level: auto, manual: false };
  };
  const axes = { sound: axis('sound'), voice: axis('voice'), vibration: axis('vibration') };
  return {
    auto,
    importancePoint: IMPORTANCE_POINT[importance],
    lateCount: lateCount4w,
    latePoint: lateCount4w >= LATE_COUNT_THRESHOLD ? 1 : 0,
    heavySleeper: wakeSensitivity === 'HEAVY',
    axes,
    manual: axes.sound.manual || axes.voice.manual || axes.vibration.manual,
    fields: {
      intensity: LEVEL_FIELDS[auto].intensity,
      voiceTone: LEVEL_FIELDS[axes.voice.level].voiceTone,
      soundKey: LEVEL_FIELDS[axes.sound.level].soundKey,
      vibration: axes.vibration.manual ? LEVEL_FIELDS[axes.vibration.level].vibration : null,
    },
  };
}

// DB 칸 값 → 단계 (이미 저장된 알람을 읽을 때). 모르는 값이면 null
export function levelOfIntensity(v: string | null | undefined): Level | null {
  const i = LEVEL_FIELDS.findIndex((f) => f.intensity === v);
  return i < 0 ? null : (i as Level);
}
export function levelOfVoiceTone(v: string | null | undefined): Level | null {
  const i = LEVEL_FIELDS.findIndex((f) => f.voiceTone === v);
  return i < 0 ? null : (i as Level);
}
export function levelOfSoundKey(v: string | null | undefined): Level | null {
  const i = LEVEL_FIELDS.findIndex((f) => f.soundKey === v);
  return i < 0 ? null : (i as Level);
}
export function levelOfVibration(v: string | null | undefined): Level | null {
  const i = LEVEL_FIELDS.findIndex((f) => f.vibration === v);
  return i < 0 ? null : (i as Level);
}

// 저장된 알람이 실제로 쓸 값 — 꾸러미(ring-package)가 늘 이 값을 실음. 칸이 비었거나 모르는 값이면 전체 세기(intensity)에서 풀어 씀
//   진동: vibration ?? 강도에서 (약 NONE · 보통 SHORT_REPEAT · 강 STRONG_CONTINUOUS)
//   배경음: sound_key ?? 강도에서 (약 theme_calm · 보통 theme_default · 강 theme_urgent). sound_key는 앱이 아는 이름 아무거나 가능해 모르는 값도 그대로 씀
export function vibrationOf(vibration: string | null | undefined, intensity: AlarmIntensity): AlarmVibration {
  const level = levelOfVibration(vibration);
  return LEVEL_FIELDS[level ?? levelOfIntensity(intensity) ?? BASE_LEVEL].vibration;
}
export function soundKeyOf(soundKey: string | null | undefined, intensity: AlarmIntensity): string {
  // 앞뒤 공백은 폰(Kotlin)과 모듈 plan.ts가 trim하므로 같게 — 안 맞으면 서버 값과 폰 값이 계속 달라 매번 재예약됨
  return soundKey?.trim() || LEVEL_FIELDS[levelOfIntensity(intensity) ?? BASE_LEVEL].soundKey;
}
