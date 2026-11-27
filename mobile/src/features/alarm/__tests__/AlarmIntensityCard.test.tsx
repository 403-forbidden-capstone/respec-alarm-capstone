import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Text as RNText, StyleSheet, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { VoiceTone } from '@shared/calc/types.ts';
import { wakeSensitivityOf } from '@shared/calc/intensity.ts';

import { setSkyTone } from '@/lib/skyTone';
import { db } from '@/mocks/data';

import { getAppointment, getIntensityBasis } from '../api';
import { AlarmIntensityCard, AUTO_LEVELS, type AxisLevels } from '../components/AlarmIntensityCard';
import { toIntensity, type AlarmRow } from '../map';
import { LEVELS, type Importance, type Level } from '../types';

// 새 일정(H05)과 알람 설정(H03)의 알람 강도 — 같은 조건이면 같은 자동 값, 같은 카드 · 같은 색
const IMPORTANCES: Importance[] = ['LOW', 'NORMAL', 'HIGH'];
const LATES = [0, 1, 2, 5];
const SENSES = ['LIGHT', 'NORMAL', 'HEAVY'] as const;
const VOICES: (Level | null)[] = [null, 0, 1, 2];
const VOICE_TONE: Record<Level, VoiceTone> = { 0: 'CALM', 1: 'NEUTRAL', 2: 'DIRECT' };

// H03이 읽는 저장된 알람 — 자동으로 저장된 기상 하나
const autoRow = (intensity: AlarmRow['intensity']): AlarmRow => ({
  alarm_id: 'w', alarm_type: 'WAKE', scheduled_at: '2026-11-27T08:00:00+09:00', intensity, voice_tone: 'NEUTRAL',
  sound_key: 'theme_default', vibration: null, is_enabled: true, time_source: 'AUTO', intensity_source: 'AUTO',
});

describe('자동 강도 — 새 일정과 알람 설정이 같은 조건이면 같음', () => {
  it('실데이터: 중요도 · 지각 · 잠귀 · 기본 말소리 모든 조합', () => {
    for (const importance of IMPORTANCES)
      for (const late of LATES)
        for (const sense of SENSES)
          for (const voice of VOICES) {
            const ws = wakeSensitivityOf(sense);
            const created = toIntensity([], importance, late, ws, voice); // 새 일정 화면 (저장 전, 알람 없음)
            const saved = toIntensity([autoRow(['SOFT', 'NORMAL', 'STRONG'][created.auto] as AlarmRow['intensity'])], importance, late, ws, voice); // 저장 뒤 알람 설정 화면
            expect({ auto: created.auto, voiceAuto: created.voiceAuto, axes: created.axes }).toEqual({ auto: saved.auto, voiceAuto: saved.voiceAuto, axes: saved.axes });
          }
  });

  describe('가짜 모드', () => {
    const keep = { lateCount4w: db.lateCount4w, wakeSensitivity: db.wakeSensitivity, voiceTone: db.voiceTone };
    afterEach(() => {
      Object.assign(db, keep);
    });

    it('getIntensityBasis로 계산한 값 = getAppointment의 강도', async () => {
      const a = db.appointments.find((x) => !db.intensityOverrides[x.id])!; // 직접 고른 축 없는 일정
      for (const late of LATES)
        for (const sense of ['NORMAL', 'HEAVY'] as const)
          for (const voice of VOICES) {
            Object.assign(db, { lateCount4w: late, wakeSensitivity: sense, voiceTone: voice == null ? null : VOICE_TONE[voice] });
            const basis = await getIntensityBasis();
            const created = toIntensity([], a.importance, basis.lateCount, basis.wakeSensitivity, basis.voiceDefault);
            const detail = (await getAppointment(a.id, { withoutAlarms: true }))!;
            expect([created.auto, created.voiceAuto, created.lateCount]).toEqual([detail.intensity.auto, detail.intensity.voiceAuto, detail.intensity.lateCount]);
          }
    });
  });
});

// 카드 그리기 — Text(keepWords)가 끼우는 U+2060은 빼고 U+00A0은 빈칸으로, 화면 글 전체를 한 줄로
type CardProps = Parameters<typeof AlarmIntensityCard>[0];
const base: CardProps = { auto: 1, voiceAuto: 1, importance: 'NORMAL', lateCount: 0, levels: AUTO_LEVELS, onChange: () => {} };
function render(props: Partial<CardProps> = {}) {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(createElement(AlarmIntensityCard, { ...base, ...props }));
  });
  const textOf = (n: ReactTestInstance): string => n.findAllByType(RNText).flatMap((t) => [t.props.children].flat()).filter((x) => typeof x === 'string').join('').replace(/⁠/g, '').replace(/ /g, ' ');
  const press = (label: string) => act(() => r.root.findAll((n) => n.props.accessibilityRole === 'button' && textOf(n) === label)[0].props.onPress());
  // 고른 약 · 중 · 강 칸의 칠한 색
  const selectedColors = () =>
    r.root
      .findAll((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityState?.selected)
      .map((n) => StyleSheet.flatten(n.findAllByType(View).map((v) => v.props.style)).backgroundColor);
  return { r, text: () => textOf(r.root), press, selectedColors, update: (p: Partial<CardProps>) => act(() => r.update(createElement(AlarmIntensityCard, { ...base, ...props, ...p }))) };
}

describe('AlarmIntensityCard', () => {
  afterEach(() => setSkyTone(null));

  it('불러오는 중에는 자동 값 대신 안내, 바꾸기도 숨김', () => {
    const v = render({ basis: 'loading' });
    expect(v.text()).toContain('불러오는 중');
    expect(v.text()).not.toContain('바꾸기');
  });

  it('못 불러오면 중요도 기준 예상값이라고 안내하고 다시 불러오기', () => {
    const onRetry = jest.fn();
    const v = render({ basis: 'fallback', importance: 'HIGH', auto: 2, onRetry });
    expect(v.text()).toContain(`중요도 매우 중요 기준 예상 ${LEVELS[2].name}`);
    expect(v.text()).toContain('저장할 때 반영돼요');
    v.press('다시 불러오기');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('다 읽으면 수정 화면과 같은 근거 줄', () => {
    expect(render({ auto: 2, lateCount: 3 }).text()).toContain(`자동 ${LEVELS[2].name} · 중요도 중요 · 최근 4주 늦잠 지각 3번`);
  });

  it('자동 값이 바뀌어도(지각 이력을 다 읽음) 직접 고른 축은 그대로', () => {
    const onChange = jest.fn<(next: AxisLevels) => void>();
    const levels: AxisLevels = { sound: 0, voice: null, vibration: 2 };
    const v = render({ basis: 'loading', levels, onChange });
    v.update({ basis: undefined, auto: 2, voiceAuto: 2 });
    expect(onChange).not.toHaveBeenCalled();
    expect(v.text()).toContain(`${LEVELS[0].name} · ${LEVELS[0].sound} · ${LEVELS[2].voice} · ${LEVELS[2].vibration}`);
    v.press('바꾸기 ›');
    expect(v.text().match(/직접 고름/g)).toHaveLength(2);
  });

  it('고른 칸 색은 지금 시간대의 포인트 색을 따름 (두 화면 모두 이 카드)', () => {
    setSkyTone({ base: '#101010', accent: '#123456' });
    const v = render();
    v.press('바꾸기 ›');
    expect(new Set(v.selectedColors())).toEqual(new Set(['#123456'])); // 배경음 · 말소리 · 진동 세 줄 모두
    act(() => setSkyTone({ base: '#202020', accent: '#654321' }));
    expect(new Set(v.selectedColors())).toEqual(new Set(['#654321']));
  });
});
