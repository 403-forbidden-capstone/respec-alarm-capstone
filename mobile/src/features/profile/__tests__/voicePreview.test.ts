import { describe, expect, it } from '@jest/globals';

import { previewVoiceName, voicePreviewOf } from '../voicePreview';

const NOW = Date.parse('2026-11-16T07:00:00+09:00');

describe('말소리 미리 듣기', () => {
  it('약 = 1단계 Android TTS 기본 높낮이 · 속도', () => {
    expect(voicePreviewOf('CALM', NOW)).toMatchObject({ kind: 'TTS', pitch: 1.0, rate: 1.0, voiceIndex: 0, text: expect.any(String) });
  });
  it('중 = 2단계 문장을 약과 같은 기본 높낮이 · 속도로 (기계음 아님)', () => {
    const mid = voicePreviewOf('NEUTRAL', NOW);
    expect(mid).toMatchObject({ kind: 'TTS', pitch: 1.0, rate: 1.0, voiceIndex: 0 });
    expect(mid).not.toEqual(voicePreviewOf('CALM', NOW)); // 문장은 2단계 것
  });
  it('강 = 3단계 Gemini 예비 WAV (API 호출 없음)', () => {
    expect(voicePreviewOf('DIRECT', NOW)).toEqual({ kind: 'GEMINI_WAV' });
  });
});

describe('미리 듣기 목소리 = 실제 알람 목소리 (오프라인 한국어 · 이름순 · 번호)', () => {
  const voices = [
    { identifier: 'ko-kr-x-kob-network', language: 'ko-KR' },
    { identifier: 'ko-kr-x-kob-local', language: 'ko-KR' },
    { identifier: 'en-us-x-sfg-local', language: 'en-US' },
    { identifier: 'ko-kr-x-ism-local', language: 'ko-KR' },
  ];
  it('번호 0은 이름순 첫째, 번호가 개수를 넘으면 나머지', () => {
    expect(previewVoiceName(voices, 0)).toBe('ko-kr-x-ism-local');
    expect(previewVoiceName(voices, 3)).toBe('ko-kr-x-kob-local');
  });
  it('오프라인 한국어 목소리가 없으면 엔진 기본', () => {
    expect(previewVoiceName([voices[0], voices[2]], 0)).toBeUndefined();
  });
});
