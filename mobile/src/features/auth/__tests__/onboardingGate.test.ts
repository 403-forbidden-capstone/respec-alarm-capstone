import { describe, expect, it } from '@jest/globals';

import { shouldOnboard, shouldReconsent, type OnboardingGateInput } from '../onboardingGate';

// 읽기를 마친 로그인 사용자 — 칸 하나씩 바꿔 가며 봄
const base: OnboardingGateInput = { inFlow: true, signedIn: true, profileReady: true, profileFailed: false, onboardedAt: null };

describe('shouldOnboard — 온보딩으로 보낼지', () => {
  describe('스위치가 켜져 있을 때 (ONBOARDING_IN_FLOW = true)', () => {
    it('로그인했고 프로필을 읽었는데 온보딩 끝난 시각이 없으면 감', () => {
      expect(shouldOnboard(base)).toBe(true);
      expect(shouldOnboard({ ...base, onboardedAt: undefined })).toBe(true);
    });

    it('온보딩 끝난 시각이 있으면 안 감', () => {
      expect(shouldOnboard({ ...base, onboardedAt: '2026-10-30T09:00:00.000Z' })).toBe(false);
    });

    it('기준은 온보딩 끝난 시각 — 아이디(handle)는 상관없음', () => {
      // 아이디가 가입 때 자동으로 생겨도 온보딩은 해야 하고, 아이디가 없어도 끝냈으면 다시 안 감
      expect(shouldOnboard({ ...base, handle: 'respec_3f2a', onboardedAt: null } as OnboardingGateInput)).toBe(true);
      expect(shouldOnboard({ ...base, handle: null, onboardedAt: '2026-10-30T09:00:00.000Z' } as OnboardingGateInput)).toBe(false);
    });

    it('로그인 전이면 안 감 — 로그인 화면이 먼저', () => {
      expect(shouldOnboard({ ...base, signedIn: false })).toBe(false);
    });

    it('프로필을 읽는 중이면 안 감 — 읽기 전에 온보딩이 잠깐 뜨지 않게', () => {
      expect(shouldOnboard({ ...base, profileReady: false })).toBe(false);
    });

    it('프로필을 못 읽었으면 안 감 — 다시 시도 화면이 맡고, 보내면 저장해 둔 값을 덮어씀', () => {
      expect(shouldOnboard({ ...base, profileFailed: true })).toBe(false);
    });
  });

  describe('스위치가 꺼져 있을 때 (ONBOARDING_IN_FLOW = false)', () => {
    const off = { ...base, inFlow: false };

    it('로그인했고 온보딩 끝난 시각이 없어도 안 감 — 바로 홈', () => {
      expect(shouldOnboard(off)).toBe(false);
    });

    it('로그인 o/x · 프로필 읽음 o/x · 온보딩 끝남 o/x 어떤 조합이어도 안 감', () => {
      for (const signedIn of [true, false]) {
        for (const profileReady of [true, false]) {
          for (const profileFailed of [true, false]) {
            for (const onboardedAt of [null, '2026-10-30T09:00:00.000Z']) {
              expect(shouldOnboard({ inFlow: false, signedIn, profileReady, profileFailed, onboardedAt })).toBe(false);
            }
          }
        }
      }
    });
  });
});

describe('shouldReconsent — 판이 올라가면 동의만 다시 (친구 13-14)', () => {
  const base = { inFlow: true, signedIn: true, profileReady: true, profileFailed: false, onboardedAt: '2026-11-01T00:00:00Z', privacyVersion: 2, currentVersion: 3 } as const;

  it('온보딩을 끝냈는데 동의한 판이 낮으면(없으면 0) 다시 받음', () => {
    expect(shouldReconsent(base)).toBe(true);
    expect(shouldReconsent({ ...base, privacyVersion: null })).toBe(true);
  });

  it('지금 판이거나 더 높으면 묻지 않음', () => {
    expect(shouldReconsent({ ...base, privacyVersion: 3 })).toBe(false);
    expect(shouldReconsent({ ...base, privacyVersion: 4 })).toBe(false);
  });

  it('온보딩 전(동의 단계가 받음) · 로그인 전 · 읽는 중 · 못 읽음 · 흐름에서 뺀 동안은 묻지 않음', () => {
    expect(shouldReconsent({ ...base, onboardedAt: null })).toBe(false);
    expect(shouldReconsent({ ...base, signedIn: false })).toBe(false);
    expect(shouldReconsent({ ...base, profileReady: false })).toBe(false);
    expect(shouldReconsent({ ...base, profileFailed: true })).toBe(false);
    expect(shouldReconsent({ ...base, inFlow: false })).toBe(false);
  });
});
