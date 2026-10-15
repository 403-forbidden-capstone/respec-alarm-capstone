// 알람 강도 — 앱 목업 계산(mocks/calc.ts autoLevel)과 같은 결과 (mocks/__tests__/calc.test.ts ALG-02)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoLevel, levelOfIntensity, levelOfSoundKey, levelOfVoiceTone, resolveIntensity } from './intensity.ts';

test('중요 일정은 중, 보통 일정은 약, 최근 4주 늦잠 지각이 2회 이상이면 한 단계 올림', () => {
  assert.equal(autoLevel('NORMAL', 1), 1); // 목업 a1 (lateCount4w = 1)
  assert.equal(autoLevel('LOW', 1), 0); // 목업 a2
  assert.equal(autoLevel('NORMAL', 2), 2);
  assert.equal(autoLevel('LOW', 2), 1); // 목업 규칙: 낮음이어도 올림 (문서 7.4.1은 LOW 제외 — D56)
  assert.equal(autoLevel('HIGH', 0), 2);
  assert.equal(autoLevel('HIGH', 5), 2); // 상한
});

test('직접 고른 칸만 그 값, 나머지는 자동 — 진동 칸이 intensity, 말소리가 voice_tone, 배경음이 sound_key', () => {
  const auto = resolveIntensity('NORMAL', 1);
  assert.equal(auto.auto, 1);
  assert.equal(auto.manual, false);
  assert.deepEqual(auto.fields, { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_default' });

  const picked = resolveIntensity('NORMAL', 1, { sound: 0, vibration: 2, voice: null });
  assert.equal(picked.manual, true);
  assert.deepEqual(picked.axes, {
    sound: { level: 0, manual: true },
    voice: { level: 1, manual: false },
    vibration: { level: 2, manual: true },
  });
  assert.deepEqual(picked.fields, { intensity: 'STRONG', voiceTone: 'NEUTRAL', soundKey: 'theme_calm' });
});

test('근거 칸: 중요도 점수 · 늦잠 횟수 · 지각 점수', () => {
  const r = resolveIntensity('NORMAL', 3);
  assert.deepEqual([r.importancePoint, r.lateCount, r.latePoint, r.auto], [1, 3, 1, 2]);
});

test('저장된 DB 값에서 단계 읽기', () => {
  assert.equal(levelOfIntensity('STRONG'), 2);
  assert.equal(levelOfVoiceTone('CALM'), 0);
  assert.equal(levelOfSoundKey('theme_default'), 1);
  assert.equal(levelOfSoundKey('theme_focus'), null);
  assert.equal(levelOfIntensity(null), null);
});
