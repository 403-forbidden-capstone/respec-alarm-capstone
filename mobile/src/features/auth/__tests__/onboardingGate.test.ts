import { describe, expect, it } from '@jest/globals';

import { shouldOnboard, type OnboardingGateInput } from '../onboardingGate';

// 읽기를 마친 로그인 사용자 — 칸 하나씩 바꿔 가며 봄
const base: OnboardingGateInput = { inFlow: true, signedIn: true, profileReady: true, profileFailed: false, handle: null };

describe('shouldOnboard — 온보딩으로 보낼지', () => {
  describe('스위치가 켜져 있을 때 (ONBOARDING_IN_FLOW = true)', () => {
    it('로그인했고 프로필을 읽었는데 아이디가 없으면 감', () => {
      expect(shouldOnboard(base)).toBe(true);
      expect(shouldOnboard({ ...base, handle: '' })).toBe(true);
      expect(shouldOnboard({ ...base, handle: undefined })).toBe(true);
    });

    it('아이디가 있으면 안 감', () => {
      expect(shouldOnboard({ ...base, handle: 'respec_kim' })).toBe(false);
    });

    it('로그인 전이면 안 감 — 로그인 화면이 먼저', () => {
      expect(shouldOnboard({ ...base, signedIn: false })).toBe(false);
    });

    it('프로필을 읽는 중이면 안 감 — 읽기 전에 온보딩이 잠깐 뜨지 않게', () => {
      expect(shouldOnboard({ ...base, profileReady: false })).toBe(false);
    });

    it('프로필을 못 읽었으면 안 감 — 다시 시도 화면이 맡고, 보내면 저장해 둔 기본값을 덮어씀', () => {
      expect(shouldOnboard({ ...base, profileFailed: true })).toBe(false);
    });
  });

  describe('스위치가 꺼져 있을 때 (ONBOARDING_IN_FLOW = false, 지금)', () => {
    const off = { ...base, inFlow: false };

    it('로그인했고 아이디가 없어도 안 감 — 바로 홈', () => {
      expect(shouldOnboard(off)).toBe(false);
    });

    it('로그인 o/x · 프로필 읽음 o/x · 아이디 o/x 어떤 조합이어도 안 감', () => {
      for (const signedIn of [true, false]) {
        for (const profileReady of [true, false]) {
          for (const profileFailed of [true, false]) {
            for (const handle of [null, 'respec_kim']) {
              expect(shouldOnboard({ inFlow: false, signedIn, profileReady, profileFailed, handle })).toBe(false);
            }
          }
        }
      }
    });
  });
});
