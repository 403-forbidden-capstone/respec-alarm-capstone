import { describe, expect, it } from '@jest/globals';

import type { LocationStatus } from '@/features/location/permissions';
import type { PermissionSnapshot } from '@/features/permissions';

import { permissionRows } from '../permissionRows';

const ALL_ON: PermissionSnapshot = {
  supported: true,
  notifications: 'on',
  notificationsAsked: true,
  fullScreen: 'on',
  exactAlarm: 'on',
  usageAccess: 'on',
};

const byKey = (rows: ReturnType<typeof permissionRows>, key: string) => rows.find((row) => row.key === key);

describe('permissionRows — 지원 안 함', () => {
  const cases: [string, PermissionSnapshot | null][] = [
    ['아직 읽는 중(null)', null],
    ['지원 안 함(웹 · 가짜 · 옛 APK)', { ...ALL_ON, supported: false, notifications: 'off', exactAlarm: 'off' }],
  ];

  it.each(cases)('%s: 모든 줄이 확인 전 · 버튼 없음 · 정확한 알람 줄 없음', (_name, snapshot) => {
    const rows = permissionRows(snapshot);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === 'unknown')).toBe(true);
    expect(rows.every((row) => row.actionLabel === undefined)).toBe(true);
    expect(byKey(rows, 'exactAlarm')).toBeUndefined();
  });
});

describe('permissionRows — 지원 + 모두 켜짐', () => {
  const rows = permissionRows(ALL_ON);

  it('알림 · 전체화면 알림 · 사용 정보는 허용, 정확한 알람 줄은 없음', () => {
    expect(byKey(rows, 'notifications')?.state).toBe('ok');
    expect(byKey(rows, 'fullScreen')?.state).toBe('ok');
    expect(byKey(rows, 'usageAccess')?.state).toBe('ok');
    expect(byKey(rows, 'exactAlarm')).toBeUndefined();
  });

  it('배터리는 확인 전 + [설정 열기] 버튼, 삼성 절전은 확인 전 + 버튼 없음', () => {
    expect(byKey(rows, 'battery')).toMatchObject({ state: 'unknown', actionLabel: '설정 열기' });
    expect(byKey(rows, 'samsung')?.state).toBe('unknown');
    expect(byKey(rows, 'samsung')?.actionLabel).toBeUndefined();
  });
});

describe('permissionRows — 일부 꺼짐', () => {
  it('알림이 꺼지면 그 줄만 꺼짐', () => {
    const rows = permissionRows({ ...ALL_ON, notifications: 'off' });
    expect(byKey(rows, 'notifications')?.state).toBe('off');
    expect(byKey(rows, 'fullScreen')?.state).toBe('ok');
  });

  it('정확한 알람이 꺼지면 줄이 생김', () => {
    const rows = permissionRows({ ...ALL_ON, exactAlarm: 'off' });
    expect(byKey(rows, 'exactAlarm')).toMatchObject({ state: 'off' });
  });

  it("정확한 알람이 '모름'이면 줄을 넣지 않음", () => {
    expect(byKey(permissionRows({ ...ALL_ON, exactAlarm: 'unknown' }), 'exactAlarm')).toBeUndefined();
  });

  it("'모름'은 확인 전으로 매핑", () => {
    expect(byKey(permissionRows({ ...ALL_ON, fullScreen: 'unknown', usageAccess: 'unknown' }), 'fullScreen')?.state).toBe('unknown');
    expect(byKey(permissionRows({ ...ALL_ON, usageAccess: 'unknown' }), 'usageAccess')?.state).toBe('unknown');
  });
});

describe('permissionRows — 줄 순서', () => {
  it('정확한 알람 줄이 없을 때', () => {
    expect(permissionRows(ALL_ON).map((row) => row.key)).toEqual(['notifications', 'fullScreen', 'usageAccess', 'battery', 'samsung']);
  });

  it('정확한 알람 줄이 있으면 전체화면 알림 뒤', () => {
    expect(permissionRows({ ...ALL_ON, exactAlarm: 'off' }).map((row) => row.key)).toEqual([
      'notifications',
      'fullScreen',
      'exactAlarm',
      'usageAccess',
      'battery',
      'samsung',
    ]);
  });
});

describe('permissionRows — 위치 줄', () => {
  const cases: [LocationStatus, 'ok' | 'off', string | undefined][] = [
    ['on', 'ok', undefined],
    ['off', 'off', '켜기'],
    ['foreground-only', 'off', '항상 허용 켜기'],
    ['coarse', 'off', '정확한 위치 켜기'],
  ];

  it.each(cases)("%s: 상태 %s · 버튼 %s", (location, state, actionLabel) => {
    const row = byKey(permissionRows(ALL_ON, location), 'location');
    expect(row?.state).toBe(state);
    expect(row?.actionLabel).toBe(actionLabel);
  });

  it("'unsupported'거나 위치를 모르면(null · 안 줌) 줄이 없음", () => {
    expect(byKey(permissionRows(ALL_ON, 'unsupported'), 'location')).toBeUndefined();
    expect(byKey(permissionRows(ALL_ON, null), 'location')).toBeUndefined();
    expect(byKey(permissionRows(ALL_ON), 'location')).toBeUndefined();
  });

  it('사용 정보 뒤 · 배터리 앞', () => {
    expect(permissionRows(ALL_ON, 'off').map((row) => row.key)).toEqual(['notifications', 'fullScreen', 'usageAccess', 'location', 'battery', 'samsung']);
  });
});
