import { beforeEach, describe, expect, it } from '@jest/globals';

import { setAfterOnboarding, takeAfterOnboarding } from '../afterOnboarding';

beforeEach(() => {
  setAfterOnboarding(null);
});

describe('afterOnboarding — 온보딩 뒤 갈 곳 메모', () => {
  it('적어 두지 않았으면 null', () => {
    expect(takeAfterOnboarding()).toBeNull();
  });

  it('한 번 읽으면 비워짐 — 두 번째는 null (루트가 다시 그려져도 일정 화면이 또 열리지 않게)', () => {
    setAfterOnboarding('schedule');
    expect(takeAfterOnboarding()).toBe('schedule');
    expect(takeAfterOnboarding()).toBeNull();
  });

  it('null로 덮어쓰면 홈에 머묾', () => {
    setAfterOnboarding('schedule');
    setAfterOnboarding(null);
    expect(takeAfterOnboarding()).toBeNull();
  });
});
