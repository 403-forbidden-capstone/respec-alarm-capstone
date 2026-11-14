import { describe, expect, it } from '@jest/globals';

import { openableHome, ringExit, type RingExitState } from '../ringExit';

const state = (patch: Partial<RingExitState> = {}): RingExitState => ({
  devAlarm: false,
  enabled: true,
  signedIn: true,
  needsOnboarding: false,
  needsReconsent: false,
  ...patch,
});

describe('알람을 끈 뒤 갈 곳 (ringExit)', () => {
  it('로그인 · 온보딩을 끝낸 기상 알람 해제 → 홈 위에 기상 확인', () => {
    expect(ringExit('WAKE', 'dismiss', state())).toEqual({ href: '/', openWake: true });
  });

  it('미루기 · 준비 · 출발 알람은 기상 확인 없이 홈', () => {
    expect(ringExit('WAKE', 'snooze', state())).toEqual({ href: '/', openWake: false });
    expect(ringExit('PREPARE', 'dismiss', state())).toEqual({ href: '/', openWake: false });
    expect(ringExit('DEPARTURE', 'done', state())).toEqual({ href: '/', openWake: false });
  });

  it('로그인 전에 울린 알람은 홈 · 기상 확인이 막혀 있으니 로그인 화면으로 (갇히던 버그)', () => {
    for (const action of ['dismiss', 'snooze', 'done'] as const) {
      expect(ringExit('WAKE', action, state({ signedIn: false }))).toEqual({ href: '/login', openWake: false });
    }
  });

  it('온보딩 · 동의 다시 받기 전이면 그 화면으로', () => {
    expect(ringExit('WAKE', 'dismiss', state({ needsOnboarding: true }))).toEqual({ href: '/onboarding', openWake: false });
    expect(ringExit('WAKE', 'dismiss', state({ needsReconsent: true }))).toEqual({ href: '/reconsent', openWake: false });
  });

  it('개발 화면 시험 알람은 로그인 여부와 상관없이 알람 테스트 화면으로 돌아감', () => {
    expect(ringExit('WAKE', 'dismiss', state({ devAlarm: true }))).toEqual({ href: '/dev/alarm-test', openWake: false });
    expect(ringExit('WAKE', 'snooze', state({ devAlarm: true, signedIn: false }))).toEqual({ href: '/dev/alarm-test', openWake: false });
  });

  it('가짜 데이터 모드(로그인 필요 없음)는 로그인 안 해도 홈', () => {
    expect(ringExit('WAKE', 'dismiss', state({ enabled: false, signedIn: false }))).toEqual({ href: '/', openWake: true });
  });
});

describe('지금 열 수 있는 첫 화면 (openableHome)', () => {
  it('알람 테스트의 "← 이전"이 앞 화면 없이 눌려도 막힌 홈 대신 로그인으로', () => {
    expect(openableHome(state({ signedIn: false }))).toBe('/login');
    expect(openableHome(state())).toBe('/');
    expect(openableHome(state({ enabled: false, signedIn: false }))).toBe('/');
  });
});
