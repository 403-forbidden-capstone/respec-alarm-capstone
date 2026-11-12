// 개발 화면(dev/alarm-test) AI 음성 시험 — 순수 함수만 (시험: __tests__/voiceTest.test.ts)
//   샘플 일정으로 서버 브리핑 규칙(@shared/briefing.ts briefingClips)을 그대로 불러 단계별 문장 · 높낮이 · 속도 · 목소리 번호를 만듦
//   폰에서 바로 만들어서 네트워크 · Supabase · Gemini 호출 없음 (비행기 모드에서도 됨). 실제 사용자 일정 · 대화는 안 씀
import type { AlarmVibration, VoiceTestInfo, VoiceTestSetup } from '@capstone/alarm-core';
import { briefingClips, resolveVoice, type BriefingInput, type BriefKind, type UrgencyRule } from '@shared/briefing.ts';
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
  if (stage === 4) return { snoozeCount: 0, rule: { dangerAtMs: nowMs - 6 * 60_000, urgentAtMs: nowMs - 60_000, maxLevel: 4 } };
  return { snoozeCount: stage - 1, rule: { dangerAtMs: null, urgentAtMs: null, maxLevel: 4 } };
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

/** 기상 시험 브리핑 — 단계 1~4 문장을 다 넣고(실제와 같이 울릴 때 단계를 고름) 미루기 횟수 · 긴급 규칙으로 단계를 재현 */
export function wakeVoiceTest(stage: Stage, nowMs: number, opts: { sound: boolean; voice: boolean }): { snoozeCount: number; voice: VoiceTestSetup } {
  const { snoozeCount, rule } = stageSetup(stage, nowMs);
  return { snoozeCount, voice: { rule, clips: briefingClips(rule, PROFILE, sampleInput('WAKE', nowMs)), test: opts } };
}

/** 앱에 든 Gemini 긴급 샘플(res/raw/gemini_urgent_sample.wav)의 문장 — 개발자가 실제 Gemini TTS로 한 번 만든 파일. 재생 때 API 호출 없음 */
export const GEMINI_SAMPLE_TEXT = '야!!!!!!!!!! 지금 안 일어나면 진짜 늦어!!!! 지금 당장 일어나!!!!!!!';

/** 샘플 비교 — 같은 샘플 문장을 4단계로: SAMPLE이면 Gemini 샘플 파일, ANDROID면 Android TTS가 읽음 */
export function geminiSampleTest(engine: 'SAMPLE' | 'ANDROID', nowMs: number, opts: { sound: boolean; voice: boolean }): { snoozeCount: number; voice: VoiceTestSetup } {
  const { snoozeCount, voice } = wakeVoiceTest(4, nowMs, opts);
  const clips = voice.clips.map((c) => (c.level === 4 ? { ...c, text: GEMINI_SAMPLE_TEXT } : c));
  return { snoozeCount, voice: { ...voice, clips, test: { ...opts, gemini: engine } } };
}

/** 시간 자동 전환 시험 — 울리기 시작 뒤 30초에 여유 5분(→ 3단계), 60초에 여유 0분(→ 4단계)이 되게. 미루기 없이 울리는 동안 바뀜. 4단계는 Gemini 샘플 */
export const AUTO_STEP_MS = 30_000;
export function autoStageTest(nowMs: number, opts: { sound: boolean; voice: boolean }): { snoozeCount: number; voice: VoiceTestSetup } {
  const rule: UrgencyRule = { dangerAtMs: nowMs + AUTO_STEP_MS, urgentAtMs: nowMs + 2 * AUTO_STEP_MS, maxLevel: 4 };
  const clips = briefingClips(rule, PROFILE, sampleInput('WAKE', nowMs)).map((c) => (c.level === 4 ? { ...c, text: GEMINI_SAMPLE_TEXT } : c));
  return { snoozeCount: 0, voice: { rule, clips, test: { ...opts, gemini: 'SAMPLE' } } };
}

/** 출발 시험 브리핑 — 1단계(출발 촉구) 한 문장만. 출발은 반복 없이 한 번 읽음 (네이티브 BriefingRules.repeatsBriefing) */
export function departureVoiceTest(nowMs: number): { snoozeCount: number; voice: VoiceTestSetup } {
  const rule: UrgencyRule = { dangerAtMs: null, urgentAtMs: null, maxLevel: 1 };
  return { snoozeCount: 0, voice: { rule, clips: briefingClips(rule, PROFILE, sampleInput('DEPARTURE', nowMs)), test: { sound: true, voice: true } } };
}

/** 화면에 보일 음성 엔진 — 4단계인데 Gemini 캐시가 없으면 "대체"라고 분명히 */
export function engineLabel(info: Pick<VoiceTestInfo, 'engine' | 'level' | 'geminiSourceAlarmId'>): string {
  if (info.engine === 'NONE') return '음성 없음 (이번 구성에서 AI 음성 끔)';
  if (info.engine === 'GEMINI' && info.geminiSourceAlarmId === 'SAMPLE') return 'Gemini 긴급 샘플 (앱에 든 파일 · 사용자 캐시 아님)';
  if (info.engine === 'GEMINI') return `캐시된 Gemini 음성 (실제 알람 ${info.geminiSourceAlarmId?.slice(0, 8) ?? '?'}… 에 미리 받아 둔 파일)`;
  return info.level === 4 ? 'Android TTS (Gemini 캐시 없음 → 대체)' : 'Android 오프라인 TTS';
}
