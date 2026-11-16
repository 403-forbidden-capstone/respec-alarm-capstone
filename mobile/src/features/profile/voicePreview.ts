// 설정 > AI 음성 브리핑 말소리 미리 듣기 — 고른 말소리(약 · 중 · 강)가 알람에서 시작하는 단계의 음성 (순수 함수, 시험: __tests__/voicePreview.test.ts)
//   약 CALM = 1단계 · 중 NEUTRAL = 2단계 Android TTS: 개발 화면 AI 음성 시험(lib/alarmSync/voiceTest)과 같은 샘플 문장 · 높낮이 · 속도 · 목소리 번호
//   강 DIRECT = 3단계 Gemini: 앱에 든 예비 WAV(GEMINI_FALLBACK_FILE[3]). Gemini API는 부르지 않음
import { wakeVoiceTest } from '@/lib/alarmSync/voiceTest';
import { START_LEVEL } from '@shared/briefing.ts';

export type VoiceTone = keyof typeof START_LEVEL;

export const VOICE_TONE_OPTIONS = [
  ['CALM', '약'],
  ['NEUTRAL', '중'],
  ['DIRECT', '강'],
] as const satisfies readonly (readonly [VoiceTone, string])[];

export type VoicePreview = { kind: 'TTS'; text: string; pitch: number; rate: number; voiceIndex: number } | { kind: 'GEMINI_WAV' };

export function voicePreviewOf(tone: VoiceTone, nowMs: number): VoicePreview {
  const level = START_LEVEL[tone];
  if (level >= 3) return { kind: 'GEMINI_WAV' };
  const clip = wakeVoiceTest(level, nowMs, { sound: false, voice: true }).voice.clips.find((c) => c.level === level);
  if (!clip) throw new Error(`${level}단계 샘플 문장이 없어요`);
  return { kind: 'TTS', text: clip.text, pitch: clip.pitch, rate: clip.rate, voiceIndex: clip.voiceIndex };
}

/**
 * 실제 알람(네이티브 BriefingRules.offlineVoice)과 같은 목소리 고르기 — 오프라인 한국어 목소리를 이름순으로 정렬해 번호(나머지)로 고름
 * 오프라인 목소리가 없으면 undefined(엔진 기본 목소리)
 * shortcut: expo-speech 목록에는 "인터넷 필요" 표시가 없어 이름에 network가 든 목소리를 인터넷 필요로 봄(구글 TTS 이름 규칙). 다른 엔진에서 어긋나면 alarm-core에 미리 듣기 함수를 둠
 */
export function previewVoiceName(voices: readonly { identifier: string; language: string }[], index: number): string | undefined {
  const offline = voices
    .filter((v) => v.language.toLowerCase().startsWith('ko') && !v.identifier.toLowerCase().includes('network'))
    .map((v) => v.identifier)
    .sort();
  return offline.length ? offline[((index % offline.length) + offline.length) % offline.length] : undefined;
}
