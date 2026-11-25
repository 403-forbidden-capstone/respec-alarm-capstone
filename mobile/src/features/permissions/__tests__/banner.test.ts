import { describe, expect, it } from '@jest/globals';

import { bannerLines, bannerSummary } from '../banner';
import type { PermissionSnapshot } from '../types';

const snapshot = (patch: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  supported: true,
  notifications: 'on',
  notificationsAsked: false,
  fullScreen: 'on',
  exactAlarm: 'on',
  usageAccess: 'on',
  ...patch,
});
const ctx = (patch: Partial<{ failedCount: number; hasAlarm: boolean }> = {}) => ({ failedCount: 0, hasAlarm: false, ...patch });

describe('bannerLines — 홈 빨간 줄', () => {
  it('다 켜져 있으면 줄이 없음', () => {
    expect(bannerLines(snapshot(), ctx({ hasAlarm: true }))).toEqual([]);
  });

  it('알림이 꺼져 있어도 묻기 전의 새 사용자(알람 없음)에게는 줄이 없음', () => {
    expect(bannerLines(snapshot({ notifications: 'off' }), ctx())).toEqual([]);
  });

  it('알림이 꺼져 있고 알람이 있으면 줄', () => {
    expect(bannerLines(snapshot({ notifications: 'off' }), ctx({ hasAlarm: true }))).toEqual([
      { key: 'notifications', text: '알림이 꺼져 있어 알람이 잠금화면에 안 떠요' },
    ]);
  });

  it('알림이 꺼져 있고 물어본 적이 있으면 알람이 없어도 줄', () => {
    expect(bannerLines(snapshot({ notifications: 'off', notificationsAsked: true }), ctx()).map((l) => l.key)).toEqual(['notifications']);
  });

  it('전체화면 알림이 꺼져 있으면 줄', () => {
    expect(bannerLines(snapshot({ fullScreen: 'off' }), ctx())).toEqual([{ key: 'fullScreen', text: '전체 화면 알림이 꺼져 있어 알람 화면이 안 떠요' }]);
  });

  it("'unknown'은 줄이 없음", () => {
    const unknown = snapshot({ notifications: 'unknown', fullScreen: 'unknown', exactAlarm: 'unknown', usageAccess: 'unknown', notificationsAsked: true });
    expect(bannerLines(unknown, ctx({ hasAlarm: true }))).toEqual([]);
  });

  it('정확한 알람 · 사용 정보 접근이 꺼져 있어도 홈 줄은 없음 (점검표에서만)', () => {
    expect(bannerLines(snapshot({ exactAlarm: 'off', usageAccess: 'off' }), ctx({ hasAlarm: true }))).toEqual([]);
  });

  it('폰에 못 건 알람이 있으면 줄', () => {
    expect(bannerLines(snapshot(), ctx({ failedCount: 2 }))).toEqual([{ key: 'failed', text: '알람 2개를 폰에 걸지 못했어요' }]);
  });

  it('권한을 못 읽는 곳(supported false · 아직 읽는 중)에서도 못 건 알람 줄은 보이고 권한 줄은 안 보임', () => {
    const unsupported = snapshot({ supported: false, notifications: 'off', fullScreen: 'off', notificationsAsked: true });
    expect(bannerLines(unsupported, ctx({ failedCount: 1, hasAlarm: true })).map((l) => l.key)).toEqual(['failed']);
    expect(bannerLines(null, ctx({ failedCount: 1 })).map((l) => l.key)).toEqual(['failed']);
    expect(bannerLines(null, ctx({ hasAlarm: true }))).toEqual([]);
  });

  it('여러 개면 알림 → 전체화면 → 못 건 알람 순', () => {
    const lines = bannerLines(snapshot({ notifications: 'off', fullScreen: 'off' }), ctx({ hasAlarm: true, failedCount: 1 }));
    expect(lines.map((l) => l.key)).toEqual(['notifications', 'fullScreen', 'failed']);
  });
});

describe('bannerSummary', () => {
  it('0개는 null, 1개는 그 글, 여럿이면 개수', () => {
    expect(bannerSummary([])).toBeNull();
    expect(bannerSummary([{ key: 'failed', text: '알람 1개를 폰에 걸지 못했어요' }])).toBe('알람 1개를 폰에 걸지 못했어요');
    expect(
      bannerSummary([
        { key: 'notifications', text: 'a' },
        { key: 'fullScreen', text: 'b' },
      ]),
    ).toBe('알람이 안 울릴 수 있어요 · 2개');
  });
});
