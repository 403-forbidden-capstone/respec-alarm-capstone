import { describe, expect, it } from '@jest/globals';

import { colors } from '@/theme';

import { contrast, dayPartOfPhase, mixHex, skyGreeting, SKY_HEIGHT, SKY_KINDS, SKY_LEAD_FROM, SKY_PHASES, SKY_SUB_TEXT_FROM, skyColorAt, skyKindOf, skyPhase, skyTop } from '../sky';

const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m);

describe('skyPhase', () => {
  it('해 뜨는 · 지는 시각을 모르면 6:30 · 18:30 기준', () => {
    expect(skyPhase(at(3))).toBe('night');
    expect(skyPhase(at(5, 49))).toBe('night');
    expect(skyPhase(at(5, 50))).toBe('dawn');
    expect(skyPhase(at(7, 9))).toBe('dawn');
    expect(skyPhase(at(7, 10))).toBe('morning');
    expect(skyPhase(at(10, 59))).toBe('morning');
    expect(skyPhase(at(11))).toBe('day');
    expect(skyPhase(at(17, 29))).toBe('day');
    expect(skyPhase(at(17, 30))).toBe('dusk');
    expect(skyPhase(at(18, 59))).toBe('dusk');
    expect(skyPhase(at(19))).toBe('night');
    expect(skyPhase(at(23, 30))).toBe('night');
  });

  it('해 뜨는 · 지는 시각을 알면 그 시각 기준 (겨울: 7:40 · 17:20)', () => {
    const rise = at(7, 40);
    const set = at(17, 20);
    expect(skyPhase(at(6, 50), rise, set)).toBe('night');
    expect(skyPhase(at(7, 30), rise, set)).toBe('dawn');
    expect(skyPhase(at(8, 30), rise, set)).toBe('morning');
    expect(skyPhase(at(13), rise, set)).toBe('day');
    expect(skyPhase(at(16, 30), rise, set)).toBe('dusk');
    expect(skyPhase(at(17, 50), rise, set)).toBe('night');
  });
});

describe('skyKindOf', () => {
  it('WMO 날씨 코드를 종류로 바꿈', () => {
    expect([0, 1].map(skyKindOf)).toEqual(['clear', 'clear']);
    expect([2, 3, 45, 48].map(skyKindOf)).toEqual(['cloudy', 'cloudy', 'cloudy', 'cloudy']);
    expect([51, 61, 67, 80, 82, 95, 99].every((c) => skyKindOf(c) === 'rain')).toBe(true);
    expect([71, 75, 77, 85, 86].every((c) => skyKindOf(c) === 'snow')).toBe(true);
  });

  it('모르는 코드는 맑음', () => {
    expect(skyKindOf(123)).toBe('clear');
  });
});

describe('skyGreeting', () => {
  it('맑으면 원래 인사말, 아니면 날씨를 얹음', () => {
    expect(skyGreeting('clear', 'morning')).toBe('좋은 아침이에요');
    expect(skyGreeting('clear', 'evening')).toBe('차분한 저녁이에요');
    expect(skyGreeting('cloudy', 'afternoon')).toBe('흐린 오후예요');
    expect(skyGreeting('rain', 'morning')).toBe('비 오는 아침이에요');
    expect(skyGreeting('snow', 'evening')).toBe('눈 오는 저녁이에요');
  });

  it('미리 보기 시간대 → 인사말 때', () => {
    expect(SKY_PHASES.map(dayPartOfPhase)).toEqual(['morning', 'morning', 'afternoon', 'evening', 'evening']);
  });
});

describe('바탕 색', () => {
  it('맨 위는 날씨 색, 물드는 높이 끝에서는 원래 바탕', () => {
    expect(skyColorAt('#C6DEF5', 0)).toBe('#C6DEF5');
    expect(skyColorAt('#C6DEF5', SKY_HEIGHT)).toBe(colors.bg);
    expect(skyColorAt('#C6DEF5', SKY_HEIGHT + 200)).toBe(colors.bg);
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('어느 날씨 · 시간대에서도 글자 대비 4.5 : 1 이상 — 맨 위는 본문 색, 보조 글자는 정한 높이부터', () => {
    for (const kind of SKY_KINDS) {
      for (const phase of SKY_PHASES) {
        const top = skyTop(kind, phase);
        expect(contrast(colors.ink, top)).toBeGreaterThanOrEqual(7);
        expect(contrast(colors.sub, skyColorAt(top, SKY_SUB_TEXT_FROM))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.skySub, skyColorAt(top, SKY_LEAD_FROM))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
