// ALG-02 알람 강도 — D56 1 기본안 → D69 (정한 것, 10/26: 기본 강도는 보통, 약은 사용자가 직접 고를 때만)
//   자동 = 보통(1)에서 시작해 올림 규칙을 단계로 더함, 상한 강(2). 중요도 낮음(LOW)이어도 기본은 보통(약으로 내려가지 않음)
//     · 중요도 매우 중요(HIGH)면 한 단계 올림 (보통 · 중요는 올림 없음)
//     · 최근 4주 늦잠 지각이 2회 이상이면 한 단계 올림
//     · 잠귀가 무거움(wakeSensitivity = HEAVY)이면 곧바로 강
//   직접 고른 칸(배경음 · 말소리 · 진동)이 있으면 그 칸은 그 값, 나머지는 자동 (약은 이 경우에만 나옴)
// 문서(7장 7.4.1 · 4장 정책표)와 다른 점은 D69를 따름:
//   · 문서: 중요도 낮음 → 늘 약 / 지금: 낮음도 기본 보통 (약은 직접 고를 때만)
//   · profiles.intensity_offset(수락한 제안 ±1)은 안 읽음 — 제안 적용은 D6 · D23~D25가 열려 있음
//   · "지각"은 appointment_participants.is_late 전체 — 7.4.1은 늦잠 원인(late_cause = WAKE)만 세므로, 그 칸이 생기면 좁힘
//   · 잠귀(profiles.wake_sensitivity) 칸이 아직 DB에 없음(L7 PR 3이 만듦) → 지금은 읽지 않아 부르는 쪽이 안 넘기면 NORMAL 취급.
//     칸이 생기면 profiles select에 더해 plan-core · map.ts toIntensity · realWrite setIntensity 세 곳에서 같이 넘길 것
//   · 7.4.1 표의 theme_focus(HIGH · 지각 이력 없음)는 3단계(약 · 중 · 강)에 없어 안 씀
import type { AlarmIntensity, Importance, IntensityAxis, Level, VoiceTone } from './types.ts';

// 중요도로 올리는 단계 수 — 매우 중요(HIGH)만 1 (D69: 중요도는 한 단계 올릴지에만 씀). 앱 라벨 보통(LOW) · 중요(NORMAL) · 매우 중요(HIGH)
export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 0, HIGH: 1 };

// 가입 때 "잠귀" 한 문항 (D69). 아직 DB 칸이 없어 안 주면 NORMAL
export type WakeSensitivity = 'HEAVY' | 'NORMAL';

// 기본 강도 = 보통 (D69)
export const BASE_LEVEL: Level = 1;
const MAX_LEVEL: Level = 2;

// 늦잠 지각이 이 횟수 이상이면 한 단계 올림 (7장 7.0.5 L_late = 2)
export const LATE_COUNT_THRESHOLD = 2;

// 단계 → DB 칸 값. 앱 LEVELS(약 '차분 · 다정' · 중 '일정 안내형' · 강 '직설형')와 7장 7.4.1 표의 톤 · 배경음 이름
export const LEVEL_FIELDS: readonly { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string }[] = [
  { intensity: 'SOFT', voiceTone: 'CALM', soundKey: 'theme_calm' },
  { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_default' },
  { intensity: 'STRONG', voiceTone: 'DIRECT', soundKey: 'theme_urgent' },
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
  // DB 칸 값: intensity = 진동 칸, voice_tone = 말소리 칸, sound_key = 배경음 칸
  fields: { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string };
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
      intensity: LEVEL_FIELDS[axes.vibration.level].intensity,
      voiceTone: LEVEL_FIELDS[axes.voice.level].voiceTone,
      soundKey: LEVEL_FIELDS[axes.sound.level].soundKey,
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
