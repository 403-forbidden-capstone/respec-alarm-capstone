import { describe, expect, it } from '@jest/globals';

import { parseRelation, permissionNames, togglePermission } from '../permissions';
import type { PermissionSet } from '../types';

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
