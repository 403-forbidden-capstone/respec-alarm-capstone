// 알람 강도 D69 — 기본 보통 · 매우 중요 / 지각 2회 / 잠귀 무거움 올림 (앱 목업 mocks/calc.ts autoLevel도 이 함수를 부름 — mocks/__tests__/calc.test.ts ALG-02)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoLevel, LATE_COUNT_THRESHOLD, levelOfIntensity, levelOfSoundKey, levelOfVibration, levelOfVoiceTone, resolveIntensity, soundKeyOf, vibrationOf, wakeSensitivityOf, type WakeSensitivity } from './intensity.ts';
import type { Importance, Level } from './types.ts';

// D69 규칙 표 — 기본 보통(1), 매우 중요(HIGH) +1, 최근 4주 늦잠 지각 2회 이상 +1, 잠귀 HEAVY면 강, 상한 강(2)
//   중요도 DB 값 LOW · NORMAL · HIGH = 앱 라벨 평소 · 중요 · 매우 중요 — 올림은 HIGH만
const IMPORTANCES = ['LOW', 'NORMAL', 'HIGH'] as const;
const RULE_TABLE: [Importance, number, WakeSensitivity, Level][] = [
  // 중요도, 지각 횟수, 잠귀, 기대 단계(0 약 · 1 중 · 2 강)
  ['LOW', 0, 'NORMAL', 1], ['LOW', 0, 'HEAVY', 2],
  ['LOW', 1, 'NORMAL', 1], ['LOW', 1, 'HEAVY', 2],
  ['LOW', 2, 'NORMAL', 2], ['LOW', 2, 'HEAVY', 2],
  ['NORMAL', 0, 'NORMAL', 1], ['NORMAL', 0, 'HEAVY', 2],
  ['NORMAL', 1, 'NORMAL', 1], ['NORMAL', 1, 'HEAVY', 2],
  ['NORMAL', 2, 'NORMAL', 2], ['NORMAL', 2, 'HEAVY', 2],
  ['HIGH', 0, 'NORMAL', 2], ['HIGH', 0, 'HEAVY', 2],
  ['HIGH', 1, 'NORMAL', 2], ['HIGH', 1, 'HEAVY', 2],
  ['HIGH', 2, 'NORMAL', 2], ['HIGH', 2, 'HEAVY', 2], // 올림이 겹쳐도 상한 강
];

test('규칙 표 18줄 (중요도 3 × 지각 0 · 1 · 2 × 잠귀 보통 · 무거움)', () => {
  assert.equal(RULE_TABLE.length, IMPORTANCES.length * 3 * 2);
  for (const [importance, late, sensitivity, want] of RULE_TABLE) {
    assert.equal(autoLevel(importance, late, sensitivity), want, `${importance} · 지각 ${late} · 잠귀 ${sensitivity}`);
    assert.equal(resolveIntensity(importance, late, {}, sensitivity).auto, want, `resolve ${importance} · 지각 ${late} · 잠귀 ${sensitivity}`);
  }
});

test('잠귀를 안 주면 보통 취급 (DB 칸이 생기기 전) · 약은 자동으로는 안 나옴', () => {
  for (const importance of IMPORTANCES) {
    for (const late of [0, 1, 2, 5]) {
      assert.equal(autoLevel(importance, late), autoLevel(importance, late, 'NORMAL'));
      assert.notEqual(autoLevel(importance, late), 0); // D69: 약은 사용자가 직접 고를 때만
      assert.notEqual(autoLevel(importance, late, 'HEAVY'), 0);
    }
  }
});

test('지각 올림은 2회부터, 상한 강', () => {
  assert.equal(autoLevel('NORMAL', LATE_COUNT_THRESHOLD - 1), 1);
  assert.equal(autoLevel('NORMAL', LATE_COUNT_THRESHOLD), 2);
  assert.equal(autoLevel('HIGH', 5), 2);
});

test('직접 고른 칸만 그 값, 나머지는 자동 — intensity는 전체 세기(자동), 진동 칸이 vibration(자동이면 null), 말소리가 voice_tone, 배경음이 sound_key', () => {
  const auto = resolveIntensity('NORMAL', 1);
  assert.equal(auto.auto, 1);
  assert.equal(auto.manual, false);
  assert.deepEqual(auto.fields, { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_default', vibration: null });

  const picked = resolveIntensity('NORMAL', 1, { sound: 0, vibration: 2, voice: null });
  assert.equal(picked.manual, true);
  assert.deepEqual(picked.axes, {
    sound: { level: 0, manual: true },
    voice: { level: 1, manual: false },
    vibration: { level: 2, manual: true },
  });
  // 진동을 강으로 직접 골라도 전체 세기(intensity)는 자동(보통) 그대로 — 진동은 vibration 칸
  assert.deepEqual(picked.fields, { intensity: 'NORMAL', voiceTone: 'NEUTRAL', soundKey: 'theme_calm', vibration: 'STRONG_CONTINUOUS' });
});

test('직접 고른 칸 사례: 약은 직접 고를 때만 — 나머지 칸은 자동(보통)', () => {
  // 중요도 낮음 · 지각 없음 = 자동 보통. 말소리만 약으로 고르면 그 칸만 약 · MANUAL
  const soft = resolveIntensity('LOW', 0, { voice: 0 });
  assert.equal(soft.auto, 1);
  assert.equal(soft.manual, true);
  assert.deepEqual(soft.axes, { sound: { level: 1, manual: false }, voice: { level: 0, manual: true }, vibration: { level: 1, manual: false } });
  assert.deepEqual(soft.fields, { intensity: 'NORMAL', voiceTone: 'CALM', soundKey: 'theme_default', vibration: null });

  // 세 칸 모두 약으로 직접 고르면 약 (매우 중요 · 잠귀 무거움이어도 직접 고른 값이 먼저)
  const allSoft = resolveIntensity('HIGH', 3, { sound: 0, voice: 0, vibration: 0 }, 'HEAVY');
  assert.equal(allSoft.auto, 2);
  // 전체 세기는 직접 고른 축과 상관없이 자동 단계(매우 중요 · 지각 · 잠귀 → 강)
  assert.deepEqual(allSoft.fields, { intensity: 'STRONG', voiceTone: 'CALM', soundKey: 'theme_calm', vibration: 'NONE' });
  assert.equal(allSoft.manual, true);

  // 고르지 않은 칸(null · 없음)은 자동 — 올림이 반영된 값
  const partial = resolveIntensity('HIGH', 0, { sound: 1, voice: null });
  assert.deepEqual(partial.axes, { sound: { level: 1, manual: true }, voice: { level: 2, manual: false }, vibration: { level: 2, manual: false } });
});

test('근거 칸: 중요도 올림 · 늦잠 횟수 · 지각 점수 · 잠귀', () => {
  const r = resolveIntensity('NORMAL', 3);
  assert.deepEqual([r.importancePoint, r.lateCount, r.latePoint, r.heavySleeper, r.auto], [0, 3, 1, false, 2]);
  const high = resolveIntensity('HIGH', 0);
  assert.deepEqual([high.importancePoint, high.latePoint, high.auto], [1, 0, 2]);
  const heavy = resolveIntensity('LOW', 0, {}, 'HEAVY');
  assert.deepEqual([heavy.heavySleeper, heavy.auto], [true, 2]);
});

test('저장된 DB 값에서 단계 읽기', () => {
  assert.equal(levelOfIntensity('STRONG'), 2);
  assert.equal(levelOfVoiceTone('CALM'), 0);
  assert.equal(levelOfSoundKey('theme_default'), 1);
  assert.equal(levelOfSoundKey('theme_focus'), null);
  assert.equal(levelOfIntensity(null), null);
  assert.equal(levelOfVibration('SHORT_REPEAT'), 1);
  assert.equal(levelOfVibration('NONE'), 0);
  assert.equal(levelOfVibration('WOBBLE'), null);
  assert.equal(levelOfVibration(null), null);
});

test('진동 칸: 자동이면 null, 직접 고르면 그 값 — 세 값 모두, 다른 축·전체 세기는 안 바뀜', () => {
  const values = [0, 1, 2].map((level) => resolveIntensity('NORMAL', 0, { vibration: level as 0 | 1 | 2 }).fields.vibration);
  assert.deepEqual(values, ['NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS']);
  const strong = resolveIntensity('NORMAL', 0, { vibration: 2 });
  assert.equal(strong.manual, true);
  assert.deepEqual([strong.fields.intensity, strong.fields.voiceTone, strong.fields.soundKey], ['NORMAL', 'NEUTRAL', 'theme_default']);
  // null · 없음 = 자동으로 → vibration null (직접 고른 뒤 "자동으로" 되돌리는 경우)
  assert.equal(resolveIntensity('NORMAL', 0, { vibration: null }).fields.vibration, null);
  assert.equal(resolveIntensity('NORMAL', 0, { vibration: null }).manual, false);
  // 말소리만 직접 골라도 진동은 null(강도를 따름) — MANUAL이어도 진동 칸은 비어 있음
  const voiceOnly = resolveIntensity('NORMAL', 0, { voice: 2 });
  assert.equal(voiceOnly.manual, true);
  assert.equal(voiceOnly.fields.vibration, null);
  // 전체 세기는 자동 단계만 따라감 (중요 일정 → 강)
  assert.equal(resolveIntensity('HIGH', 0, { sound: 0, voice: 0, vibration: 0 }).fields.intensity, 'STRONG');
});

test('꾸러미에 실을 값 풀기: 진동 vibration ?? 강도에서, 배경음 sound_key ?? 강도에서', () => {
  assert.deepEqual((['SOFT', 'NORMAL', 'STRONG'] as const).map((i) => vibrationOf(null, i)), ['NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS']);
  assert.deepEqual((['SOFT', 'NORMAL', 'STRONG'] as const).map((i) => soundKeyOf(null, i)), ['theme_calm', 'theme_default', 'theme_urgent']);
  // 직접 고른 값이 먼저 (강도와 달라도)
  assert.equal(vibrationOf('NONE', 'STRONG'), 'NONE');
  assert.equal(soundKeyOf('theme_focus', 'SOFT'), 'theme_focus');
  // 모르는 진동 값 · 빈 글자는 강도를 따름
  assert.equal(vibrationOf('WOBBLE', 'STRONG'), 'STRONG_CONTINUOUS');
  assert.equal(vibrationOf(undefined, 'SOFT'), 'NONE');
  assert.equal(soundKeyOf('', 'STRONG'), 'theme_urgent');
});

test('wakeSensitivityOf: DB 값 HEAVY만 HEAVY, LIGHT · NORMAL · 모르는 값 · 빈 값은 NORMAL (약은 직접 고를 때만, D69)', () => {
  assert.deepEqual(['HEAVY', 'LIGHT', 'NORMAL', 'x', '', null, undefined].map(wakeSensitivityOf), ['HEAVY', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL']);
  // 가벼움 + 보통 일정 → 보통 (약 아님)
  assert.equal(autoLevel('NORMAL', 0, wakeSensitivityOf('LIGHT')), 1);
});

test('설정의 기본 말소리는 말소리를 직접 안 골랐을 때만 — 다른 축 · 전체 세기는 그대로, 직접 고른 말소리가 이김', () => {
  const r = resolveIntensity('NORMAL', 0, {}, 'NORMAL', 2);
  assert.deepEqual(r.axes.voice, { level: 2, manual: false });
  assert.equal(r.fields.voiceTone, 'DIRECT');
  assert.equal(r.fields.intensity, 'NORMAL');
  assert.equal(r.fields.soundKey, 'theme_default');
  assert.equal(r.manual, false); // 기본 말소리는 직접 고른 값이 아님 → intensity_source AUTO
  assert.equal(resolveIntensity('NORMAL', 0, { voice: 0 }, 'NORMAL', 2).fields.voiceTone, 'CALM');
  assert.equal(resolveIntensity('NORMAL', 0, {}, 'NORMAL', null).fields.voiceTone, 'NEUTRAL'); // 비면 자동
});
