// 백그라운드 브리핑 갱신(#515) 기기 키 — 발급 · 유지 · 만료 임박 재발급 · 다른 계정 로그인 · 로그아웃 · 계정 삭제 · 예전 APK
import { describe, expect, it, jest } from '@jest/globals';
import type { BriefingDeviceInfo, BriefingDeviceKey } from '@capstone/alarm-core';

import { DEVICE_RENEW_BEFORE_MS, ensureBriefingDevice, forgetBriefingDevice, type BriefingDeviceDeps } from '../briefingDevice';

jest.mock('@capstone/alarm-core', () => ({}));
jest.mock('../../edge', () => ({ callEdge: jest.fn() }));
jest.mock('../../supabase', () => ({ supabaseUrl: '', supabasePublicKey: '' }));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function deps(stored: BriefingDeviceKey | null = null, over: Partial<BriefingDeviceDeps> = {}) {
  let key = stored;
  const issued: string[] = [];
  const revoked: string[] = [];
  const d: BriefingDeviceDeps = {
    supported: true,
    url: 'https://proj.supabase.co/',
    apikey: 'sb_publishable_x',
    get: async (): Promise<BriefingDeviceInfo | null> => (key ? { userId: key.userId, deviceId: key.deviceId, expiresAt: key.expiresAt } : null),
    set: async (v) => {
      key = v;
    },
    clear: async () => {
      key = null;
    },
    issue: async (deviceId) => {
      issued.push(deviceId);
      return { token: `bdk_${'x'.repeat(43)}`, expires_at: new Date(NOW + 30 * DAY).toISOString() };
    },
    revoke: async (deviceId) => void revoked.push(deviceId),
    newId: () => 'new-device',
    ...over,
  };
  return { d, issued, revoked, key: () => key };
}
const saved = (userId: string, expiresAt: number): BriefingDeviceKey => ({ url: 'u', apikey: 'k', token: 'bdk_old', userId, deviceId: 'old-device', expiresAt });

describe('ensureBriefingDevice', () => {
  it('키가 없으면 받아서 네이티브에 넘김 — 함수 주소 · 공개 키 · 사용자 · 만료', async () => {
    const t = deps();
    expect(await ensureBriefingDevice('u1', NOW, t.d)).toBe('ISSUED');
    expect(t.issued).toEqual(['new-device']);
    expect(t.key()).toEqual({
      url: 'https://proj.supabase.co/functions/v1/alarm-briefing-device',
      apikey: 'sb_publishable_x',
      token: `bdk_${'x'.repeat(43)}`,
      userId: 'u1',
      deviceId: 'new-device',
      expiresAt: NOW + 30 * DAY,
    });
  });

  it('같은 계정 키가 넉넉히 남았으면 서버를 안 부름 · 만료 7일 전이면 같은 기기 id로 다시 받음', async () => {
    const kept = deps(saved('u1', NOW + DEVICE_RENEW_BEFORE_MS + DAY));
    expect(await ensureBriefingDevice('u1', NOW, kept.d)).toBe('KEPT');
    expect(kept.issued).toEqual([]);
    const soon = deps(saved('u1', NOW + DEVICE_RENEW_BEFORE_MS - 1));
    expect(await ensureBriefingDevice('u1', NOW, soon.d)).toBe('ISSUED');
    expect(soon.issued).toEqual(['old-device']);
  });

  it('다른 계정 키가 남아 있으면 지우고 새 기기 id로 이 계정 키를 받음', async () => {
    const t = deps(saved('someone-else', NOW + 20 * DAY));
    const clear = jest.fn(t.d.clear);
    expect(await ensureBriefingDevice('u1', NOW, { ...t.d, clear })).toBe('ISSUED');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(t.issued).toEqual(['new-device']);
    expect(t.key()?.userId).toBe('u1');
  });

  it('예전 APK · 서버 주소 없음이면 아무것도 안 함 · 발급이 실패하면 던지고 저장된 키는 그대로', async () => {
    const old = deps(null, { supported: false });
    expect(await ensureBriefingDevice('u1', NOW, old.d)).toBe('SKIPPED');
    expect(await ensureBriefingDevice('u1', NOW, deps(null, { url: '' }).d)).toBe('SKIPPED');
    const fail = deps(saved('u1', NOW + DAY), { issue: async () => Promise.reject(new Error('NETWORK')) });
    await expect(ensureBriefingDevice('u1', NOW, fail.d)).rejects.toThrow('NETWORK');
    expect(fail.key()?.token).toBe('bdk_old');
  });
});

describe('forgetBriefingDevice', () => {
  it('로그아웃: 서버 줄 폐기 + 폰 키 삭제 — 서버를 못 불러도 폰 키는 지움', async () => {
    const t = deps(saved('u1', NOW + DAY), { revoke: async () => Promise.reject(new Error('NETWORK')) });
    await forgetBriefingDevice({ revoke: true }, t.d);
    expect(t.key()).toBeNull();
    const ok = deps(saved('u1', NOW + DAY));
    await forgetBriefingDevice({ revoke: true }, ok.d);
    expect(ok.revoked).toEqual(['old-device']);
  });

  it('계정 삭제: 서버 줄은 계정과 같이 지워져서 폰 키만 지움', async () => {
    const t = deps(saved('u1', NOW + DAY));
    await forgetBriefingDevice({ revoke: false }, t.d);
    expect(t.revoked).toEqual([]);
    expect(t.key()).toBeNull();
  });
});
