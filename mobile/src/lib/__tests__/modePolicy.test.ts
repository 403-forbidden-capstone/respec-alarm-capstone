import { describe, expect, it } from '@jest/globals';

import { modePolicy, resolveMode, showDevLogin, type ModeEnv } from '../modePolicy';

const env = (patch: Partial<ModeEnv>): ModeEnv => ({ web: false, dev: false, configured: true, ready: true, ...patch });

describe('데이터 모드 규칙 (modePolicy)', () => {
  it('실데이터 스위치가 꺼져 있으면 어디서든 가짜 · 못 바꾸는 것도 아님', () => {
    for (const web of [true, false]) {
      for (const dev of [true, false]) {
        const policy = modePolicy(env({ web, dev, ready: false }));
        expect(policy).toEqual({ canUseReal: false, locked: false, configError: false, defaultMode: 'mock' });
        expect(resolveMode(policy, { url: 'real', saved: 'real' })).toBe('mock');
      }
    }
  });

  it('폰 출시용 빌드(__DEV__ false)는 실데이터 고정 — 주소 · 저장값이 가짜여도 실데이터', () => {
    const policy = modePolicy(env({}));
    expect(policy).toEqual({ canUseReal: true, locked: true, configError: false, defaultMode: 'real' });
    expect(resolveMode(policy, { url: 'mock', saved: 'mock' })).toBe('real');
  });

  it('폰 출시용 빌드인데 Supabase 값이 없으면 가짜로 돌지 않고 설정 오류', () => {
    const policy = modePolicy(env({ configured: false }));
    expect(policy).toEqual({ canUseReal: false, locked: true, configError: true, defaultMode: 'real' });
    expect(resolveMode(policy, { saved: 'mock' })).toBe('real'); // 가짜로 안 바뀜
  });

  it('폰 개발용(__DEV__ true)은 바꿀 수 있고 기본은 실데이터', () => {
    const policy = modePolicy(env({ dev: true }));
    expect(policy).toEqual({ canUseReal: true, locked: false, configError: false, defaultMode: 'real' });
    expect(resolveMode(policy)).toBe('real');
    expect(resolveMode(policy, { saved: 'mock' })).toBe('mock');
  });

  it('폰 개발용인데 Supabase 값이 없으면 가짜만 (설정 오류 아님)', () => {
    const policy = modePolicy(env({ dev: true, configured: false }));
    expect(policy).toEqual({ canUseReal: false, locked: false, configError: false, defaultMode: 'mock' });
    expect(resolveMode(policy, { saved: 'real' })).toBe('mock');
  });

  it('웹은 기본이 가짜, 주소 ?mode=real이면 실데이터 · 주소가 저장값보다 먼저', () => {
    const policy = modePolicy(env({ web: true }));
    expect(policy).toEqual({ canUseReal: true, locked: false, configError: false, defaultMode: 'mock' });
    expect(resolveMode(policy)).toBe('mock');
    expect(resolveMode(policy, { url: 'real' })).toBe('real');
    expect(resolveMode(policy, { saved: 'real' })).toBe('real'); // 전에 실데이터로 바꿔 둔 브라우저
    expect(resolveMode(policy, { url: 'mock', saved: 'real' })).toBe('mock');
  });

  it('웹이어도 Supabase 값이 없으면 ?mode=real이 가짜', () => {
    const policy = modePolicy(env({ web: true, configured: false }));
    expect(policy.canUseReal).toBe(false);
    expect(resolveMode(policy, { url: 'real' })).toBe('mock');
  });

  it('개발 메뉴 이메일 로그인은 웹 · 폰 개발용에서만, 출시용 폰 · 값 없음 · 스위치 꺼짐에서는 안 보임', () => {
    expect(showDevLogin(env({ web: true }))).toBe(true);
    expect(showDevLogin(env({ dev: true }))).toBe(true);
    expect(showDevLogin(env({}))).toBe(false);
    expect(showDevLogin(env({ web: true, configured: false }))).toBe(false);
    expect(showDevLogin(env({ web: true, ready: false }))).toBe(false);
  });
});
