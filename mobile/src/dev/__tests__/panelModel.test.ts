import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { modePolicy } from '@/lib/modePolicy';

import { accountLabel, DEV_TOOLS, modeBlock, type ModeBlockInput } from '../panelModel';

// 실제 규칙표(modePolicy)에서 나온 값을 넣어 패널이 /dev/screens와 같은 판단을 하는지 봄
function input(env: { ready: boolean; configured: boolean; web?: boolean; dev?: boolean }, rest: Partial<ModeBlockInput> = {}): ModeBlockInput {
  const policy = modePolicy({ web: env.web ?? true, dev: env.dev ?? true, configured: env.configured, ready: env.ready });
  return {
    mode: policy.defaultMode,
    ready: env.ready,
    canUseReal: policy.canUseReal,
    locked: policy.locked,
    devLogin: env.ready && env.configured,
    signedIn: false,
    email: null,
    nickname: null,
    ...rest,
  };
}

describe('데이터 모드 블록 (웹 미리보기 패널)', () => {
  it('실데이터를 쓸 수 있는 웹 — 흐리게 하지 않고 이유도 없음', () => {
    const block = modeBlock(input({ ready: true, configured: true }));
    expect(block).toMatchObject({ realDisabled: false, reason: null });
  });

  it('Supabase 값이 없는 빌드 — 실데이터를 흐리게 하고 이유 한 줄', () => {
    const block = modeBlock(input({ ready: true, configured: false }));
    expect(block?.realDisabled).toBe(true);
    expect(block?.reason).toBe('Supabase 주소 · 키가 없어 실데이터를 쓸 수 없어요');
  });

  it('REAL_DATA_READY가 꺼진 빌드 — 값이 있어도 흐리게, 이유는 스위치', () => {
    const block = modeBlock(input({ ready: false, configured: true }));
    expect(block?.realDisabled).toBe(true);
    expect(block?.reason).toBe('REAL_DATA_READY가 꺼져 있어 실데이터를 쓸 수 없어요');
  });

  it('모드를 못 바꾸는 빌드(폰 출시용)는 블록 자체가 없음 — /dev/screens가 토글을 안 그리는 것과 같음', () => {
    expect(modeBlock(input({ ready: true, configured: true, web: false, dev: false }))).toBeNull();
  });

  it('가짜 모드에는 계정 줄이 없음 (로그인 상태가 남아 있어도)', () => {
    const block = modeBlock(input({ ready: true, configured: true }, { mode: 'mock', signedIn: true, email: 'demo-me@example.com' }));
    expect(block?.account).toEqual({ kind: 'none' });
  });

  it('실데이터 + 로그인 전 — 개발용 이메일 로그인 버튼', () => {
    const block = modeBlock(input({ ready: true, configured: true }, { mode: 'real' }));
    expect(block?.account).toEqual({ kind: 'signedOut', devLogin: true });
  });

  it('실데이터 + 로그인 전인데 개발용 로그인을 못 쓰는 빌드 — 버튼 없이 "로그인 전"만', () => {
    const block = modeBlock(input({ ready: true, configured: true }, { mode: 'real', devLogin: false }));
    expect(block?.account).toEqual({ kind: 'signedOut', devLogin: false });
  });

  it('실데이터 + 로그인됨 — 이메일이 있으면 이메일', () => {
    const block = modeBlock(input({ ready: true, configured: true }, { mode: 'real', signedIn: true, email: 'demo-me@example.com', nickname: '지형' }));
    expect(block?.account).toEqual({ kind: 'signedIn', label: 'demo-me@example.com' });
  });

  it('실데이터를 못 쓰면 저장된 mode가 real이어도 계정 줄을 그리지 않음', () => {
    const block = modeBlock(input({ ready: true, configured: false }, { mode: 'real', signedIn: true, email: 'x@example.com' }));
    expect(block?.account).toEqual({ kind: 'none' });
  });
});

describe('accountLabel — 이메일 → 닉네임 → 없음', () => {
  it('이메일이 먼저, 없거나 공백이면 닉네임 (카카오 계정은 이메일이 없을 수 있음)', () => {
    expect(accountLabel('a@example.com', '지형')).toBe('a@example.com');
    expect(accountLabel(null, '지형')).toBe('지형');
    expect(accountLabel('  ', '지형')).toBe('지형');
    expect(accountLabel(undefined, ' 지형 ')).toBe('지형');
  });

  it('둘 다 없으면 null', () => {
    expect(accountLabel(null, null)).toBeNull();
    expect(accountLabel('', '  ')).toBeNull();
  });
});

describe('개발 도구 목록', () => {
  it('알람 테스트 · 부품 모음 · 개발 메뉴 순서로, 주소가 실제 화면 파일과 맞음', () => {
    expect(DEV_TOOLS.map((t) => t.name)).toEqual(['알람 테스트', '부품 모음', '개발 메뉴']);
    for (const tool of DEV_TOOLS) {
      expect(typeof tool.href).toBe('string');
      expect(existsSync(join(__dirname, '../../app', `${tool.href as string}.tsx`))).toBe(true);
    }
  });

  it('이름 · 설명이 비어 있지 않고 이름이 겹치지 않음', () => {
    const names = DEV_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(DEV_TOOLS.every((t) => t.name.length > 0 && t.note.length > 0)).toBe(true);
  });
});
