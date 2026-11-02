import { describe, expect, it } from '@jest/globals';

import { ONBOARDING_STEPS } from '@/lib/flags';

import { activeSteps, nextStep, ONBOARDING_ORDER, prevStep, startStep, stepNumber, type StepFlags } from '../steps';

// 모두 켠 표 — 순서 배열 그대로
const ALL_ON = Object.fromEntries(ONBOARDING_ORDER.map((id) => [id, true])) as StepFlags;
// 화면을 만든 단계만 켠 표 (lib/flags 기본값) — 마이크는 끔
const DEFAULT_ON = ['handle', 'nickname', 'sleep', 'home', 'prepare', 'timetable', 'consent', 'permissions', 'share', 'first'];

describe('온보딩 단계 순서', () => {
  it('순서는 레인 정의 그대로, 중복 없음', () => {
    expect(ONBOARDING_ORDER).toEqual(['handle', 'nickname', 'sleep', 'home', 'prepare', 'timetable', 'consent', 'permissions', 'share', 'first', 'mic']);
    expect(new Set(ONBOARDING_ORDER).size).toBe(ONBOARDING_ORDER.length);
  });

  it('켜고 끄는 표에 모든 단계가 있음', () => {
    expect(Object.keys(ONBOARDING_STEPS).sort()).toEqual([...ONBOARDING_ORDER].sort());
  });
});

describe('activeSteps', () => {
  it('모두 켜면 전부, 순서 유지', () => {
    expect(activeSteps(ALL_ON)).toEqual([...ONBOARDING_ORDER]);
  });

  it('꺼진 단계는 건너뜀', () => {
    expect(activeSteps({ ...ALL_ON, home: false, mic: false })).toEqual(ONBOARDING_ORDER.filter((id) => id !== 'home' && id !== 'mic'));
  });

  it('기본 표는 만든 단계만 켬', () => {
    expect(activeSteps()).toEqual(DEFAULT_ON);
  });

  it('모두 끄면 빈 목록', () => {
    expect(activeSteps(Object.fromEntries(ONBOARDING_ORDER.map((id) => [id, false])) as StepFlags)).toEqual([]);
  });
});

describe('nextStep · prevStep', () => {
  it('모두 켠 표: 바로 다음 · 바로 앞', () => {
    expect(nextStep('handle', ALL_ON)).toBe('nickname');
    expect(nextStep('sleep', ALL_ON)).toBe('home');
    expect(prevStep('nickname', ALL_ON)).toBe('handle');
    expect(prevStep('prepare', ALL_ON)).toBe('home');
  });

  it('모두 켠 표: 끝은 null — 마지막은 mic, 첫 단계는 handle', () => {
    expect(nextStep('mic', ALL_ON)).toBeNull();
    expect(prevStep('handle', ALL_ON)).toBeNull();
  });

  it('기본 표: 꺼진 단계를 건너뛰고 이어짐', () => {
    expect(nextStep('timetable')).toBe('consent');
    expect(nextStep('consent')).toBe('permissions');
    expect(nextStep('permissions')).toBe('share');
    expect(prevStep('share')).toBe('permissions');
    expect(prevStep('permissions')).toBe('consent');
    expect(prevStep('consent')).toBe('timetable');
  });

  it('기본 표: 끝은 first(그 뒤 mic은 꺼져 있어 null), 첫 단계는 앞이 없음', () => {
    expect(nextStep('first')).toBeNull();
    expect(prevStep('handle')).toBeNull();
  });

  it('꺼진 단계에서 부르면 null — 현재 단계가 목록에 없음', () => {
    expect(nextStep('mic')).toBeNull();
    expect(prevStep('mic')).toBeNull();
  });
});

describe('stepNumber — 진행 표시', () => {
  it('모두 켠 표: 1부터 세고 전체는 11', () => {
    expect(stepNumber('handle', ALL_ON)).toEqual({ step: 1, total: 11 });
    expect(stepNumber('home', ALL_ON)).toEqual({ step: 4, total: 11 });
    expect(stepNumber('mic', ALL_ON)).toEqual({ step: 11, total: 11 });
  });

  it('기본 표: 켠 단계만 셈 — 전체 10', () => {
    expect(stepNumber('handle')).toEqual({ step: 1, total: 10 });
    expect(stepNumber('prepare')).toEqual({ step: 5, total: 10 });
    expect(stepNumber('first')).toEqual({ step: 10, total: 10 });
  });

  it('꺼진 단계는 step 0', () => {
    expect(stepNumber('mic').step).toBe(0);
  });
});

describe('startStep — 주소 step으로 단계 바로 열기', () => {
  it('켜진 단계면 그 단계', () => {
    expect(startStep('prepare')).toBe('prepare');
    expect(startStep('first')).toBe('first');
  });

  it('없거나 꺼진 단계 · 낯선 값이면 첫 단계', () => {
    expect(startStep(undefined)).toBe('handle');
    expect(startStep('mic')).toBe('handle');
    expect(startStep('nope')).toBe('handle');
    expect(startStep(['home'])).toBe('handle');
    expect(startStep('home', { ...ALL_ON, handle: false })).toBe('home');
    expect(startStep(undefined, { ...ALL_ON, handle: false })).toBe('nickname');
  });
});
