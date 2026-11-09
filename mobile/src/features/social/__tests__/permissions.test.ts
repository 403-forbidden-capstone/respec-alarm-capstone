import { describe, expect, it } from '@jest/globals';

import { parseRelation, permissionNames, togglePermission } from '../permissions';
import { PERMISSIONS, permissionsFor, type PermissionSet } from '../types';

const set = (viewAlarm: boolean, editAlarm: boolean, viewWake: boolean): PermissionSet => ({ viewAlarm, editAlarm, viewWake });

describe('F03 권한 스위치', () => {
  it('하나만 바꾸고 나머지는 그대로', () => {
    expect(togglePermission(set(true, false, false), 'viewWake', true)).toEqual(set(true, false, true));
    expect(togglePermission(set(true, false, true), 'viewWake', false)).toEqual(set(true, false, false));
  });

  it('설정을 켜면 조회도 켬 (설정은 조회가 있어야 고칠 수 있음)', () => {
    expect(togglePermission(set(false, false, false), 'editAlarm', true)).toEqual(set(true, true, false));
  });

  it('조회를 끄면 설정도 끔', () => {
    expect(togglePermission(set(true, true, true), 'viewAlarm', false)).toEqual(set(false, false, true));
  });

  it('설정만 끄면 조회는 남음', () => {
    expect(togglePermission(set(true, true, false), 'editAlarm', false)).toEqual(set(true, false, false));
  });

  it('받은 값을 바꾸지 않고 새 값을 돌려줌', () => {
    const before = set(false, false, false);
    togglePermission(before, 'editAlarm', true);
    expect(before).toEqual(set(false, false, false));
  });
});

describe('권한 이름', () => {
  it('켜진 것만 화면 순서대로', () => {
    expect(permissionNames(set(true, false, true))).toEqual(['알람 조회', '기상 상태 조회']);
    expect(permissionNames(set(false, false, false))).toEqual([]);
  });
});

describe('관계 id', () => {
  it('종류와 키로 나눔', () => {
    expect(parseRelation('friend:sy')).toEqual({ kind: 'friend', key: 'sy' });
    expect(parseRelation('group:cap')).toEqual({ kind: 'group', key: 'cap' });
  });
});

describe('F03 스위치 목록 · 문구 (6-30 · 6-41)', () => {
  it('친구 관계는 알람 조회 · 알람 설정 2개만(기상 조회 없음), 그룹 관계는 기상 조회(그룹 동의)까지 3개', () => {
    expect(permissionsFor('friend').map((p) => p.key)).toEqual(['viewAlarm', 'editAlarm']);
    expect(permissionsFor('group').map((p) => p.key)).toEqual(['viewAlarm', 'editAlarm', 'viewWake']);
  });

  it("알람 조회 문구는 '알람 시간 · 일정 · 장소 · 준비 시간을 볼 수 있어요' (6-d7)", () => {
    expect(PERMISSIONS.find((p) => p.key === 'viewAlarm')?.description).toBe('알람 시간 · 일정 · 장소 · 준비 시간을 볼 수 있어요.');
  });
});
