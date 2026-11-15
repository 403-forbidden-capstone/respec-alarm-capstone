// 개발 화면(dev/alarm-test) AI 음성 시험 — 순수 함수만 (시험: __tests__/voiceTest.test.ts)
//   샘플 일정으로 서버 브리핑 규칙(@shared/briefing.ts briefingClips)을 그대로 불러 단계별 문장 · 높낮이 · 속도 · 목소리 번호를 만듦
//   폰에서 바로 만들어서 네트워크 · Supabase · Gemini 호출 없음 (비행기 모드에서도 됨). 실제 사용자 일정 · 대화는 안 씀
import type { AlarmVibration, VoiceSource, VoiceTestGemini, VoiceTestInfo, VoiceTestSetup } from '@capstone/alarm-core';
import {
  androidVoice,
  briefingClips,
  GEMINI_FALLBACK_FILE,
  GEMINI_FALLBACK_TEXT,
  GEMINI_STAGE,
  isGeminiLevel,
  resolveVoice,
  speakable,
  type BriefingInput,
  type BriefKind,
  type UrgencyRule,
} from '@shared/briefing.ts';
import { localDayRange } from '@shared/tz.ts';

export const SAMPLE_TIME_ZONE = 'Asia/Seoul';

/** 샘플 일정 — 화면에 "테스트 샘플"로 표시 (실제 사용자 데이터 아님) */
export const SAMPLE = {
  title: '팀플 회의',
  hour: 10, // 오전 10시
  items: ['노트북', '충전기', '필기구'],
  travelMinutes: 50, // 출발 9:10
} as const;

// 샘플 일정의 중요도 — 보통(NORMAL) 기본 목소리 · 말투 (사용자 수동 설정 없음)
const PROFILE = resolveVoice('NORMAL');

export type Stage = 1 | 2 | 3 | 4;
export type Mix = 'SOUND' | 'VIBRATION' | 'VOICE' | 'ALL';
/** 시험 옵션 — 소리 · 음성 켜기 + 3 · 4단계 출처 모의 */
export type VoiceOpts = { sound: boolean; voice: boolean; gemini?: VoiceTestGemini };

/** Gemini WAV 재생 속도 — 네이티브 BriefingRules.wavSpeed와 같은 고정값 (실제 알람 · 시험 모두) */
export const GEMINI_SPEED: Record<3 | 4, number> = { 3: 1.0, 4: 1.2 };

/** 단계별 엔진 · 목소리 · 예비 파일 · 속도 (화면 설명용, 서버 규칙 값 그대로) */
export function stageVoice(stage: Stage): string {
  if (isGeminiLevel(stage)) return `Gemini TTS · ${GEMINI_STAGE[stage].voice} 목소리 · 예비 ${GEMINI_FALLBACK_FILE[stage]} · ${GEMINI_SPEED[stage].toFixed(1)}배`;
  const v = androidVoice(PROFILE, stage);
  return `Android TTS · 높낮이 ${v.pitch.toFixed(1)} · 속도 ${v.rate.toFixed(1)}`;
}

// 오늘 출발 시각(9:10)이 이미 지났으면 내일 10시 — 지난 시각이면 울림 화면에 "출발보다 499분 늦어요"처럼 의미 없는 경고가 뜸 (11/12 에뮬레이터)
//   4단계(여유 0분)는 이 시각이 아니라 VoiceTest가 단계를 강제해서 재현하므로 영향 없음
export function sampleAppointmentAt(nowMs: number): number {
  const today = localDayRange(new Date(nowMs), SAMPLE_TIME_ZONE).start.getTime() + SAMPLE.hour * 3_600_000;
  const departToday = today - SAMPLE.travelMinutes * 60_000;
  return departToday > nowMs ? today : today + 24 * 3_600_000;
}

function sampleInput(kind: BriefKind, nowMs: number): BriefingInput {
  const atMs = sampleAppointmentAt(nowMs);
  return {
    kind,
    memo: null, // 전날 대화는 실제 기록만 쓰므로 시험에서는 비움
    appointments: [{ title: SAMPLE.title, atMs, importance: 'NORMAL' }],
    todos: SAMPLE.items.map((title) => ({ title, type: 'ITEM' as const })),
    departAtMs: kind === 'WAKE' ? atMs - SAMPLE.travelMinutes * 60_000 : null,
    timeZone: SAMPLE_TIME_ZONE,
  };
}

/**
 * 단계 재현 (시험 화면이 강제로 고름) — 실제 판단 식(네이티브 SpeechUrgency · 서버 levelAt)은 그대로 두고 입력만 맞춤
 *   1~3: 미루기 0 · 1 · 2번 (긴급 시각 없음 → 그 뒤 실제로 미루면 단계가 실제로 오름)
 *   4: 여유 0분 시각을 지금보다 1분 전으로 → 남은 여유 0분 이하와 같은 입력
 */
export function stageSetup(stage: Stage, nowMs: number): { snoozeCount: number; rule: UrgencyRule } {
  if (stage === 4) return { snoozeCount: 0, rule: { urgentAtMs: nowMs - 60_000, maxLevel: 4, startLevel: 1 } };
  return { snoozeCount: stage - 1, rule: { urgentAtMs: null, maxLevel: 4, startLevel: 1 } };
}

/** 재생 구성 → 알람음 · AI 음성 켜기 + 실제로 쓸 진동 */
export function mixOptions(mix: Mix, vibration: AlarmVibration): { sound: boolean; voice: boolean; vibration: AlarmVibration } {
  switch (mix) {
    case 'SOUND':
      return { sound: true, voice: false, vibration: 'NONE' };
    case 'VIBRATION':
      return { sound: false, voice: false, vibration };
    case 'VOICE':
      return { sound: false, voice: true, vibration: 'NONE' };
    default:
      return { sound: true, voice: true, vibration };
  }
}

/**
 * 기상 시험 브리핑 — 단계 1~4 문장을 다 넣고(실제와 같이 울릴 때 단계를 고름) 미루기 횟수 · 긴급 규칙으로 단계를 재현
 * 3 · 4단계 음성은 opts.gemini 출처 모의대로 네이티브가 고름 — 개인화 캐시 → 앱에 든 예비 WAV → Android TTS. Gemini API는 안 부름
 */
export function wakeVoiceTest(stage: Stage, nowMs: number, opts: VoiceOpts): { snoozeCount: number; voice: VoiceTestSetup } {
  const { snoozeCount, rule } = stageSetup(stage, nowMs);
  return { snoozeCount, voice: { rule, clips: briefingClips(rule, PROFILE, sampleInput('WAKE', nowMs)), test: opts } };
}

/** 시간 자동 전환 시험 — 울리기 시작 뒤 30초에 여유 5분(→ 3단계), 60초에 여유 0분(→ 4단계)이 되게. 미루기 없이 울리는 동안 바뀜 */
export const AUTO_STEP_MS = 30_000;
export function autoStageTest(nowMs: number, opts: VoiceOpts): { snoozeCount: number; voice: VoiceTestSetup } {
  // 여유 5분 → 3단계 규칙은 없어짐 — 1단계로 울리다 여유 0분(2 × AUTO_STEP_MS 뒤)에 4단계
  const rule: UrgencyRule = { urgentAtMs: nowMs + 2 * AUTO_STEP_MS, maxLevel: 4, startLevel: 1 };
  return { snoozeCount: 0, voice: { rule, clips: briefingClips(rule, PROFILE, sampleInput('WAKE', nowMs)), test: opts } };
}

/** 1 → 2 → 3 → 4 차례 시험 — 단계마다 이만큼 울린 뒤 다음 단계로 다시 울림 (2단계는 미루기로만 오므로 시각 전환으로는 재현 못 함) */
export const SEQUENCE_STEP_MS = 20_000;
export const SEQUENCE: Stage[] = [1, 2, 3, 4];

/** 출발 시험 브리핑 — 1단계(출발 촉구) 한 문장만. 출발은 반복 없이 한 번 읽음 (네이티브 BriefingRules.repeatsBriefing) */
export function departureVoiceTest(nowMs: number): { snoozeCount: number; voice: VoiceTestSetup } {
  const rule: UrgencyRule = { urgentAtMs: null, maxLevel: 1, startLevel: 1 };
  return { snoozeCount: 0, voice: { rule, clips: briefingClips(rule, PROFILE, sampleInput('DEPARTURE', nowMs)), test: { sound: true, voice: true } } };
}

/** 화면에 보일 음성 출처 — 개인화 캐시 / 기본 예비 WAV / Android TTS 대체를 분명히. source가 없으면(예전 APK) 엔진으로 짐작 */
export function engineLabel(info: Pick<VoiceTestInfo, 'engine' | 'level' | 'geminiSourceAlarmId'> & { source?: VoiceSource | null }): string {
  if (info.engine === 'NONE') return '음성 없음 (이번 구성에서 AI 음성 끔)';
  const source = info.source ?? (info.engine === 'GEMINI' ? 'GEMINI_CACHE' : (info.level ?? 0) >= 3 ? 'ANDROID_FALLBACK' : 'ANDROID');
  switch (source) {
    case 'GEMINI_CACHE':
      return `Gemini 개인화 캐시 (실제 알람 ${info.geminiSourceAlarmId?.slice(0, 8) ?? '?'}… 에 미리 받아 둔 파일)`;
    case 'GEMINI_FALLBACK':
      return `Gemini 기본 예비 WAV (앱에 든 ${info.level != null && isGeminiLevel(info.level) ? GEMINI_FALLBACK_FILE[info.level] : `${info.level}단계 파일`} · 개인화 캐시 아님 · 네트워크 없음)`;
    case 'ANDROID_FALLBACK':
      return 'Android TTS 대체 재생 (Gemini 음성을 못 씀)';
    default:
      return 'Android 오프라인 TTS';
  }
}

/** 실제로 들리는 대사 — 예비 WAV면 그 파일의 고정 대사, 아니면 단계 문장 */
export function spokenText(level: number | null | undefined, source: VoiceSource | null | undefined, clipText: string | null): string | null {
  return source === 'GEMINI_FALLBACK' && level != null && isGeminiLevel(level) ? speakable(GEMINI_FALLBACK_TEXT[level]) : clipText;
}
