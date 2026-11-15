// 개발 화면 AI 음성 시험 — 단계 재현이 실제 판단 식(levelAt)과 같은 단계를 고르는지 · 문장 · 말투가 서버 규칙 그대로인지 · 재생 구성
import { describe, expect, it } from '@jest/globals';
import type { VoiceTestSetup } from '@capstone/alarm-core';
import {
  androidVoice,
  briefingText,
  engineFor,
  GEMINI_FALLBACK_TEXT,
  levelAt as sharedLevelAt,
  resolveVoice,
  type UrgencyLevel,
  type UrgencyRule,
} from '@shared/briefing.ts';

import { isDevAlarmId, isVoiceTestId, makeDevAlarmId, makeVoiceTestAlarmId } from '../devAlarm';
import {
  AUTO_STEP_MS,
  autoStageTest,
  departureVoiceTest,
  engineLabel,
  mixOptions,
  SAMPLE,
  sampleAppointmentAt,
  SEQUENCE,
  GEMINI_SPEED,
  spokenText,
  stageVoice,
  wakeVoiceTest,
  type Stage,
} from '../voiceTest';

const NOW = Date.UTC(2026, 10, 11, 22, 0); // 서울 11/12 오전 7시
const ON = { sound: true, voice: true };
// 네이티브에 넘기는 rule(숫자 상한)을 서버 판단 식에 그대로 넣음
const levelAt = (rule: VoiceTestSetup['rule'], snoozeCount: number, nowMs: number) => sharedLevelAt(rule as UrgencyRule, snoozeCount, nowMs);

describe('기상 AI 음성 단계 재현', () => {
  it.each([1, 2, 3, 4] as Stage[])('%i단계 버튼 → 실제 판단 식(levelAt, 네이티브 SpeechUrgency와 같음)이 그 단계를 고름', (stage) => {
    const { snoozeCount, voice } = wakeVoiceTest(stage, NOW, ON);
    expect(levelAt(voice.rule!, snoozeCount, NOW)).toBe(stage);
  });

  it('1~3단계 재현은 긴급 규칙이 없어 실제로 미루면 2 → 3으로만 오르고 긴급(4)은 안 됨', () => {
    const { voice } = wakeVoiceTest(1, NOW, ON);
    expect([0, 1, 2, 3].map((n) => levelAt(voice.rule!, n, NOW))).toEqual([1, 2, 3, 3]);
  });

  it('단계마다 서버 규칙의 문장 · 높낮이 · 속도 · 목소리 그대로 (1단계 1.0/1.0, 2단계 1.7/1.5)', () => {
    const { voice } = wakeVoiceTest(1, NOW, ON);
    const profile = resolveVoice('NORMAL');
    expect(voice.clips.map((c) => c.level)).toEqual([1, 2, 3, 4]);
    for (const clip of voice.clips) {
      expect(clip).toMatchObject(androidVoice(profile, clip.level as UrgencyLevel));
    }
    expect(voice.clips[0].text).toContain('좋은 아침이야.');
    expect(voice.clips[0].text).toContain(SAMPLE.title);
    expect(voice.clips[0].text).toContain('노트북, 충전기, 필기구');
    expect(voice.clips[3].text).toBe(
      briefingText(4, {
        kind: 'WAKE',
        memo: null,
        appointments: [{ title: SAMPLE.title, atMs: Date.UTC(2026, 10, 12, 1, 0), importance: 'NORMAL' }],
        todos: SAMPLE.items.map((title) => ({ title, type: 'ITEM' as const })),
        departAtMs: Date.UTC(2026, 10, 12, 0, 10),
        timeZone: 'Asia/Seoul',
      }),
    );
    expect(voice.clips.slice(0, 2).map((c) => [c.pitch, c.rate])).toEqual([
      [1.0, 1.0],
      [1.7, 1.5],
    ]);
    expect(stageVoice(1)).toBe('Android TTS · 높낮이 1.0 · 속도 1.0');
    expect(stageVoice(2)).toBe('Android TTS · 높낮이 1.7 · 속도 1.5');
    expect(stageVoice(3)).toBe('Gemini TTS · Gacrux 목소리 · 예비 gemini_stage4_fallback.wav · 1.0배');
    expect(stageVoice(4)).toBe('Gemini TTS · Kore 목소리 · 예비 gemini_urgent_sample.wav · 1.2배');
  });

  it('3 · 4단계 엔진 — 개인화 캐시 · 예비 WAV · Android 대체를 구분해 표시', () => {
    expect(engineFor(3, true)).toBe('GEMINI');
    expect(engineFor(4, false)).toBe('ANDROID');
    expect(engineFor(2, true)).toBe('ANDROID');
    expect(engineLabel({ engine: 'GEMINI', level: 4, geminiSourceAlarmId: '11111111-2222', source: 'GEMINI_CACHE' })).toContain('개인화 캐시');
    expect(engineLabel({ engine: 'GEMINI', level: 3, geminiSourceAlarmId: null, source: 'GEMINI_FALLBACK' })).toContain('gemini_stage4_fallback.wav');
    expect(engineLabel({ engine: 'GEMINI', level: 4, geminiSourceAlarmId: null, source: 'GEMINI_FALLBACK' })).toContain('gemini_urgent_sample.wav');
    expect(engineLabel({ engine: 'ANDROID', level: 4, geminiSourceAlarmId: null, source: 'ANDROID_FALLBACK' })).toContain('대체 재생');
    // 예전 APK(source 없음)는 엔진 · 단계로 짐작
    expect(engineLabel({ engine: 'ANDROID', level: 4, geminiSourceAlarmId: null })).toContain('대체');
    expect(engineLabel({ engine: 'ANDROID', level: 2, geminiSourceAlarmId: null })).toBe('Android 오프라인 TTS');
    expect(engineLabel({ engine: 'NONE', level: null, geminiSourceAlarmId: null })).toContain('음성 없음');
  });

  it('보이는 대사 — 예비 WAV면 그 단계 파일의 고정 대사(3은 3, 4는 4), 아니면 단계 문장', () => {
    expect(spokenText(3, 'GEMINI_FALLBACK', '개인화')).toBe(GEMINI_FALLBACK_TEXT[3]);
    expect(spokenText(4, 'GEMINI_FALLBACK', '개인화')).toBe('야! 지금 안 일어나면 진짜 늦어! 지금 당장 일어나!'); // 느낌표 정리해 보임
    expect(spokenText(4, 'ANDROID_FALLBACK', '개인화')).toBe('개인화');
    expect(spokenText(3, 'GEMINI_CACHE', '개인화')).toBe('개인화');
  });
});

describe('시간 자동 전환 · 차례 시험 · 출처 모의', () => {
  it('자동 전환 — 미루기 없이 시각만 지나면 시작 단계(1) 그대로 → 4(여유 0분), 여유 5분 3단계는 없음, 출처 모의는 그대로 넘김', () => {
    const opts = { ...ON, gemini: 'FALLBACK' as const };
    const { snoozeCount, voice } = autoStageTest(NOW, opts);
    const at = (ms: number) => levelAt(voice.rule!, snoozeCount, NOW + ms);
    expect([at(0), at(AUTO_STEP_MS - 1), at(AUTO_STEP_MS), at(2 * AUTO_STEP_MS - 1), at(2 * AUTO_STEP_MS)]).toEqual([1, 1, 1, 1, 4]);
    expect(voice.test).toEqual(opts);
    expect(voice.clips.map((c) => c.level)).toEqual([1, 2, 3, 4]);
  });

  it('차례 시험 1 → 2 → 3 → 4 — 각 단계 재현이 실제 판단 식과 같은 단계', () => {
    expect(SEQUENCE).toEqual([1, 2, 3, 4]);
    for (const stage of SEQUENCE) {
      const { snoozeCount, voice } = wakeVoiceTest(stage, NOW, ON);
      expect(levelAt(voice.rule!, snoozeCount, NOW)).toBe(stage);
    }
  });

  it('출처 모의는 네이티브에 그대로, 속도는 고정 3단계 1.0배 · 4단계 1.2배 (API 호출 없음)', () => {
    expect(GEMINI_SPEED).toEqual({ 3: 1.0, 4: 1.2 });
    for (const gemini of ['CACHE', 'FALLBACK', 'BROKEN', 'ANDROID'] as const) {
      expect(wakeVoiceTest(4, NOW, { ...ON, gemini }).voice.test).toEqual({ ...ON, gemini });
    }
    expect(wakeVoiceTest(4, NOW, ON).voice.test.gemini).toBeUndefined(); // 기본은 네이티브 CACHE
  });

  it('음성 시험 알람 id — 개발 알람(서버 맞추기 · 통계 제외)이면서, [즉시 정지]는 음성 시험만 골라 끔', () => {
    const voiceId = makeVoiceTestAlarmId();
    expect(voiceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isDevAlarmId(voiceId)).toBe(true);
    expect(isVoiceTestId(voiceId)).toBe(true);
    expect(isVoiceTestId(makeDevAlarmId().replace(/^de70a1a0-a1ce-/, 'de70a1a0-0000-'))).toBe(false);
  });
});

describe('출발 AI 브리핑 시험', () => {
  it('1단계 출발 촉구 한 문장만 — 일정 · 준비물을 서버 규칙대로 읽음', () => {
    const { snoozeCount, voice } = departureVoiceTest(NOW);
    expect(voice.clips).toHaveLength(1);
    expect(levelAt(voice.rule!, snoozeCount, NOW)).toBe(1);
    expect(voice.clips[0].text).toBe('오전 10시 팀플 회의 갈 시간이야. 챙길 것: 노트북, 충전기, 필기구. 이제 출발하자.'); // 1단계는 Android TTS라 느낌표 없음
    expect(voice.test).toEqual({ sound: true, voice: true });
  });
});

describe('재생 구성', () => {
  it('알람음만 · 진동만 · AI 음성만 · 전체', () => {
    expect(mixOptions('SOUND', 'STRONG_CONTINUOUS')).toEqual({ sound: true, voice: false, vibration: 'NONE' });
    expect(mixOptions('VIBRATION', 'SHORT_REPEAT')).toEqual({ sound: false, voice: false, vibration: 'SHORT_REPEAT' });
    expect(mixOptions('VOICE', 'SHORT_REPEAT')).toEqual({ sound: false, voice: true, vibration: 'NONE' });
    expect(mixOptions('ALL', 'STRONG_CONTINUOUS')).toEqual({ sound: true, voice: true, vibration: 'STRONG_CONTINUOUS' });
  });

  it('진동 없음(NONE)을 고르면 전체 함께여도 진동 없음 그대로', () => {
    expect(mixOptions('ALL', 'NONE').vibration).toBe('NONE');
    expect(mixOptions('VIBRATION', 'NONE')).toEqual({ sound: false, voice: false, vibration: 'NONE' });
  });
});

describe('시험 샘플 일정 시각 (sampleAppointmentAt)', () => {
  // 서울 시각 → epoch ms
  const seoul = (iso: string) => new Date(`${iso}+09:00`).getTime();

  it('오늘 출발(9:10) 전이면 오늘 10시', () => {
    expect(sampleAppointmentAt(seoul('2026-11-12T07:00:00'))).toBe(seoul('2026-11-12T10:00:00'));
  });

  it('출발 시각이 지났으면 내일 10시 — 오후에 시험해도 "499분 늦어요"가 안 뜸', () => {
    expect(sampleAppointmentAt(seoul('2026-11-12T09:10:00'))).toBe(seoul('2026-11-13T10:00:00'));
    expect(sampleAppointmentAt(seoul('2026-11-12T17:23:00'))).toBe(seoul('2026-11-13T10:00:00'));
  });
});
