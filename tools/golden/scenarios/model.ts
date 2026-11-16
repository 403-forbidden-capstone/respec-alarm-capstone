// 알람 강도 · 준비시간 예측 시나리오 — intensity · prepare
//   반올림(Math.round는 .5를 위로 · 음수는 -2.5 → -2)과 문자 → 숫자(Number('0x1A') = 26 · Number('') = 0)가 파이썬과 가장 다른 곳
import { IMPORTANCES, rng, type Add } from './kit.ts';

const WAKE_SENS = [undefined, 'NORMAL', 'HEAVY'] as const;
const LEVELS = [0, 1, 2] as const;

function intensity(add: Add) {
  for (const v of [undefined, null, '', 'HEAVY', 'NORMAL', 'LIGHT', 'heavy', 'Heavy ', 'x']) add('intensity', 'wakeSensitivityOf', `${JSON.stringify(v ?? null)}-${v === undefined ? 'undef' : 'v'}`, v);
  for (const imp of IMPORTANCES) {
    for (const late of [0, 1, 2, 3, 10]) for (const wake of WAKE_SENS) add('intensity', 'autoLevel', `${imp}-late${late}-${wake}`, imp, late, wake);
  }
  const overrideSets = [
    {},
    { sound: 0 },
    { sound: 2 },
    { voice: 0 },
    { vibration: 1 },
    { sound: null, voice: null, vibration: null },
    { sound: 0, voice: 1, vibration: 2 },
    { sound: 2, voice: 0 },
    { vibration: 0 },
    { voice: 2, vibration: 0 },
  ];
  for (const imp of IMPORTANCES) {
    for (const late of [0, 2, 5]) {
      for (const wake of WAKE_SENS) {
        overrideSets.forEach((o, i) => add('intensity', 'resolveIntensity', `${imp}-late${late}-${wake}-o${i}`, imp, late, o, wake));
      }
    }
  }
  add('intensity', 'resolveIntensity', 'default-overrides', 'HIGH', 3);
  add('intensity', 'resolveIntensity', 'fractional-late-count', 'LOW', 1.5, {}, 'NORMAL');
  // 설정의 기본 말소리(profiles.preferred_voice_tone 단계) — 말소리를 직접 안 골랐을 때만 말소리 축에 씀
  for (const def of [null, 0, 1, 2] as const) {
    add('intensity', 'resolveIntensity', `voice-default${def}`, 'NORMAL', 0, {}, 'NORMAL', def);
    add('intensity', 'resolveIntensity', `voice-default${def}-picked`, 'HIGH', 2, { voice: 0, sound: 2 }, 'HEAVY', def);
  }
  for (const fn of ['levelOfIntensity', 'levelOfVoiceTone', 'levelOfSoundKey', 'levelOfVibration'] as const) {
    const values = [null, undefined, '', ' ', 'x', 'soft', 'SOFT', 'NORMAL', 'STRONG', 'CALM', 'NEUTRAL', 'DIRECT', 'theme_calm', 'theme_default', 'theme_urgent', 'NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS', ' theme_calm'];
    values.forEach((v, i) => add('intensity', fn, `v${i}`, v));
  }
  for (const vib of [null, undefined, '', 'NONE', 'SHORT_REPEAT', 'STRONG_CONTINUOUS', 'x']) {
    for (const level of ['SOFT', 'NORMAL', 'STRONG']) add('intensity', 'vibrationOf', `${vib}-${level}`, vib, level);
  }
  add('intensity', 'vibrationOf', 'unknown-intensity', null, 'LOUD');
  for (const sound of [null, undefined, '', '  ', 'theme_urgent', ' theme_urgent ', 'custom_key', 'THEME_CALM']) {
    for (const level of ['SOFT', 'NORMAL', 'STRONG']) add('intensity', 'soundKeyOf', `${JSON.stringify(sound ?? null)}-${sound === undefined ? 'undef' : 'v'}-${level}`, sound, level);
  }
  add('intensity', 'soundKeyOf', 'unknown-intensity', null, 'LOUD');
}

function prepare(add: Add) {
  const r = rng(0x9e4a);
  // predictPrepare: .5 경계 — n = prior일 때 weight 0.5, residual이 홀수면 반올림이 갈림
  for (const residual of [5, 7, -5, -7, 1, -1, 3, -3, 0]) {
    add('prepare', 'predictPrepare', `half-weight-residual${residual}`, { commonP80: 50, personalP80: 50 + residual, sampleCount: 10, prior: 10 });
  }
  const grid = { common: [15, 20.5, 50], personal: [null, undefined, 10, 50, 80, 120], samples: [0, 1, 4, 5, 14, 15, 30, 4.9, -3, 7.5], prior: [undefined, 0, 5, 10, 25], override: [undefined, null, 0, 30] };
  for (let i = 0; i < 140; i++) {
    const personal = r.pick(grid.personal);
    const prior = r.pick(grid.prior);
    const override = r.pick(grid.override);
    add('prepare', 'predictPrepare', `rand-${i}`, {
      commonP80: r.pick(grid.common),
      ...(personal === undefined ? {} : { personalP80: personal }),
      sampleCount: r.pick(grid.samples),
      ...(prior === undefined ? {} : { prior }),
      ...(override === undefined ? {} : { override }),
    });
  }
  add('prepare', 'predictPrepare', 'zero-n-zero-prior', { commonP80: 50, personalP80: 80, sampleCount: 0, prior: 0 });
  add('prepare', 'predictPrepare', 'personal-but-no-samples', { commonP80: 50, personalP80: 80, sampleCount: 0 });
  for (const [p, b] of [[50, 20], [30.5, 20], [30.4, 20], [-30.5, 0], [0.5, 0], [-0.5, 0], [1.5, 0], [2.5, 0], [-1.5, 0], [-2.5, 0], [10, -20], [0, 0]]) add('prepare', 'toMorningMinutes', `${p}-${b}`, p, b);
  // percentile
  const lists: number[][] = [[], [7], [1, 2], [1, 2, 3], [10, 20, 30, 40], [5, 1, 4, 2, 3], [10, 10, 10, 10, 10], [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], [12, 15, 30, 18, 22, 45, 60, 25, 20, 33, 41], [0.5, 1.5, 2.5]];
  for (const [i, list] of lists.entries()) for (const p of [0, 0.1, 0.5, 0.7, 0.8, 0.9, 1]) add('prepare', 'percentile', `list${i}-p${p}`, list, p);
  for (let i = 0; i < 30; i++) add('prepare', 'percentile', `rand-${i}`, Array.from({ length: r.int(0, 12) }, () => r.int(10, 240)), r.pick([0.7, 0.8, 0.9, 0.25, 0.95]));
  for (const v of [undefined, null, '', 'TIGHT', 'NORMAL', 'LOOSE', 'tight', 'x']) add('prepare', 'wakeMarginOf', `${JSON.stringify(v ?? null)}-${v === undefined ? 'undef' : 'v'}`, v);
  for (const margin of ['TIGHT', 'NORMAL', 'LOOSE']) for (const imp of IMPORTANCES) add('prepare', 'marginForImportance', `${margin}-${imp}`, margin, imp);
  // prepareStatsOf: 새 것부터. 숫자 · 글자 · 빈 값 · 범위 밖 · 30개 창
  const rawLists: (number | string | null | undefined)[][] = [
    [],
    [45],
    [10, 240],
    [9.99, 240.01],
    [9, 241, 5, 300, 100],
    ['45', ' 45 ', '1e2', '0x1A', '', ' ', 'abc', 'Infinity', '-50', '0b101', '4.5e1', '１２０'],
    [null, 30, null, 40],
    [Number.NaN, 30, Infinity, -Infinity, 31],
    Array.from({ length: 35 }, (_, i) => 20 + i),
    Array.from({ length: 35 }, (_, i) => (i % 2 ? 'x' : 60 + i)),
    [30.5, 31.5, 29.5, 28.5],
    [10, 10, 10, 10, 10],
  ];
  rawLists.forEach((list, i) => add('prepare', 'prepareStatsOf', `case-${i}`, list.map((v) => (v === undefined ? null : v))));
  for (let i = 0; i < 25; i++) {
    add('prepare', 'prepareStatsOf', `rand-${i}`, Array.from({ length: r.int(0, 40) }, () => r.pick([r.int(10, 240), r.int(0, 400), String(r.int(10, 240)), null, `${r.int(10, 240)}.5`, 'n/a'])));
  }
  const statsList = [
    { sampleCount: 0, p80: null },
    { sampleCount: 3, p80: 44 },
    { sampleCount: 3, p80: 44, values: [] },
    { sampleCount: 5, p80: 50, values: [30, 40, 50, 60, 70] },
    { sampleCount: 8, p80: 60, values: [20, 25, 30, 35, 40, 45, 50, 55] },
    { sampleCount: 10, p80: 60, values: [31.5, 29.5, 28.5, 30.5, 40, 50, 60, 70, 80, 90] },
  ];
  for (const [i, stats] of statsList.entries()) {
    for (const margin of ['TIGHT', 'NORMAL', 'LOOSE']) for (const imp of IMPORTANCES) add('prepare', 'personalPrepareOf', `stats${i}-${margin}-${imp}`, stats, margin, imp);
    add('prepare', 'recentPrepareOf', `stats${i}`, stats);
  }
  for (const n of [-1, 0, 1, 4, 5, 6, 14, 15, 20, 4.9, 5.1, 100]) add('prepare', 'prepareSourceLabel', `${n}`, n);
  const recents: number[][] = [[], [30], [30, 40, 50], [30.5, 40.5, 50.5], [1, 2, 3, 4, 5, 6, 7], [Number.NaN, 30, Infinity, 45], [Number.NaN], [29.5, 30.5, 31.4, 31.6]];
  recents.forEach((list, i) => add('prepare', 'prepareRecentLabel', `case-${i}`, list));
}

export function modelScenarios(add: Add) {
  intensity(add);
  prepare(add);
}
