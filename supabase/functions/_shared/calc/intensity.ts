// ALG-02 알람 강도 — 앱 목업 계산(mocks/calc.ts autoLevel · axisLevel)을 그대로 옮김 (D56 열림 = 목업 규칙 유지)
//   자동 = 중요도 점수(보통 0 · 중요 1 · 매우 중요 2) + 최근 4주 늦잠 지각이 2회 이상이면 1 → 0~2
//   직접 고른 칸(배경음 · 말소리 · 진동)이 있으면 그 칸은 그 값, 나머지는 자동
// 문서(7장 7.4.1 · 4장 정책표)와 다른 점은 목업 쪽을 따름 (전체작업계획 F1 → D56):
//   · 중요도 낮음(LOW)이어도 지각 2회 이상이면 한 단계 올림 (문서: LOW는 늘 약)
//   · profiles.intensity_offset(수락한 제안 ±1)은 안 읽음 — 제안 적용은 D6 · D23~D25가 열려 있음
//   · "지각"은 appointment_participants.is_late (late_cause = WAKE 칸이 DB에 없음)
//   · 7.4.1 표의 theme_focus(HIGH · 지각 이력 없음)는 목업 3단계(약 · 중 · 강)에 없어 안 씀
import type { AlarmIntensity, Importance, IntensityAxis, Level, VoiceTone } from './types.ts';

export const IMPORTANCE_POINT: Record<Importance, number> = { LOW: 0, NORMAL: 1, HIGH: 2 };

// 늦잠 지각이 이 횟수 이상이면 한 단계 올림 (7장 7.0.5 L_late = 2)
export const LATE_COUNT_THRESHOLD = 2;

// 단계 → DB 칸 값. 앱 LEVELS(약 '차분 · 다정' · 중 '일정 안내형' · 강 '직설형')와 7장 7.4.1 표의 톤 · 배경음 이름
export const LEVEL_FIELDS: readonly { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string }[] = [
  { intensity: 'SOFT', voiceTone: 'CALM', soundKey: 'theme_calm' },
  { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_default' },
  { intensity: 'STRONG', voiceTone: 'DIRECT', soundKey: 'theme_urgent' },
];

export function autoLevel(importance: Importance, lateCount4w: number): Level {
  const late = lateCount4w >= LATE_COUNT_THRESHOLD ? 1 : 0;
  return Math.max(0, Math.min(2, IMPORTANCE_POINT[importance] + late)) as Level;
}

export type IntensityOverrides = Partial<Record<IntensityAxis, Level | null>>;

export type ResolvedIntensity = {
  auto: Level; // 중요도 + 최근 4주 늦잠 지각으로 정한 값
  importancePoint: number;
  lateCount: number;
  latePoint: number; // 2회 이상이면 1
  axes: Record<IntensityAxis, { level: Level; manual: boolean }>;
  manual: boolean; // 한 칸이라도 직접 고름 → alarms.intensity_source = MANUAL
  // DB 칸 값: intensity = 진동 칸, voice_tone = 말소리 칸, sound_key = 배경음 칸
  fields: { intensity: AlarmIntensity; voiceTone: VoiceTone; soundKey: string };
};

export function resolveIntensity(importance: Importance, lateCount4w: number, overrides: IntensityOverrides = {}): ResolvedIntensity {
  const auto = autoLevel(importance, lateCount4w);
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
