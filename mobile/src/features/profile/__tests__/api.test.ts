import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { calls, filterOf, onCall, resetFake } from '@/features/records/testing/fakeSupabase';
import { UserError } from '@/lib/errors';

import { finishOnboarding, saveProfileFields } from '../api';
import type { Profile } from '../types';

// 프로필 저장이 어느 칸을 어떤 조건으로 쓰는지 — 가짜 클라이언트로 확인 (진짜 DB는 안 붙임)
jest.mock('@/lib/supabase', () => ({
  supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>('@/features/records/testing/fakeSupabase').fakeClient,
}));

const row = { user_id: 'user-1', nickname: '지형', handle: 'respec_kim' } as Profile;

beforeEach(() => {
  resetFake();
});

describe('saveProfileFields', () => {
  it('내 행(user_id)만 골라 받은 칸만 쓰고 갱신된 프로필을 돌려줌', async () => {
    onCall(() => ({ data: [row] }));
    const saved = await saveProfileFields('user-1', { nickname: '지형', wake_sensitivity: 'HEAVY' });

    expect(saved).toBe(row);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('profiles');
    expect(calls[0].op).toBe('update');
    expect(calls[0].payload).toEqual({ nickname: '지형', wake_sensitivity: 'HEAVY' });
    expect(filterOf(calls[0], 'eq', 'user_id')).toEqual(['user_id', 'user-1']);
  });

  it('집과 감지 범위(home_radius_m)를 한 번에 저장하고, 돌려받는 칸에도 읽어 옴', async () => {
    onCall(() => ({ data: [row] }));
    await saveProfileFields('user-1', { home_name: '우리집', home_lat: 37.5, home_lng: 127, home_radius_m: 300 });
    expect(calls[0].payload).toEqual({ home_name: '우리집', home_lat: 37.5, home_lng: 127, home_radius_m: 300 });
    expect(calls[0].columns).toContain('home_radius_m');
  });

  it('그 밖의 DB 오류는 원문 그대로 던짐 (화면이 기본 문구로 바꿈)', async () => {
    onCall(() => ({ error: { code: '42501', message: 'permission denied' } }));
    const result = saveProfileFields('user-1', { nickname: 'x' });
    await expect(result).rejects.not.toBeInstanceOf(UserError);
  });

  it('0행 갱신(RLS에 막힘 등)이면 오류 — 저장한 줄 알고 넘어가지 않게', async () => {
    onCall(() => ({ data: [] }));
    await expect(saveProfileFields('user-1', { nickname: 'x' })).rejects.toThrow('내 프로필을 바꾸지 못했어요');
  });
});

describe('finishOnboarding', () => {
  it('온보딩 끝낸 시각(onboarded_at)만 지금 시각으로 씀', async () => {
    onCall(() => ({ data: [row] }));
    const before = Date.now();
    await finishOnboarding('user-1');

    const payload = calls[0].payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['onboarded_at']);
    const written = Date.parse(payload.onboarded_at as string);
    expect(written).toBeGreaterThanOrEqual(before);
    expect(written).toBeLessThanOrEqual(Date.now());
    expect(filterOf(calls[0], 'eq', 'user_id')).toEqual(['user_id', 'user-1']);
  });

  it('0행이면 오류', async () => {
    onCall(() => ({ data: [] }));
    await expect(finishOnboarding('user-1')).rejects.toThrow('내 프로필을 바꾸지 못했어요');
  });
});
