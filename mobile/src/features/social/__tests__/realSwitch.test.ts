import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import * as api from '../api';
import type { PermissionSet } from '../types';

// api.ts가 함수 맨 앞에서 실데이터(real/)와 가짜를 나누는지 — 본보기: features/alarm/__tests__/realSwitch.test.ts
//   실데이터 모드면 받은 인자 그대로 real로 넘기고 가짜 데이터를 건드리지 않음, 가짜 모드면 real을 부르지 않음
let mockIsMock = true;
jest.mock('@/lib/mode', () => ({ ...jest.requireActual<object>('@/lib/mode'), isMock: () => mockIsMock }));

const mockReal = jest.fn((name: string, ...args: unknown[]) => {
  void args;
  return Promise.resolve(`real:${name}`);
});
jest.mock('../real', () => {
  const names = [
    'listFriends',
    'listFriendRequests',
    'acceptFriend',
    'listGroups',
    'getGroupSummary',
    'getGroup',
    'getFriendGrant',
    'listRelations',
    'getRelation',
    'getShareSettings',
    'saveShareSettings',
    'getReceived',
    'getMemberWake',
    'getSharedAlarms',
    'setSharedAlarmEnabled',
    'shiftSharedAlarm',
    'getShareLog',
    'sendWakePing',
    'searchByHandle',
    'searchPeople',
    'myFriendLink',
    'openFriendLink',
    'sendFriendRequest',
    'createGroup',
    'joinGroupByCode',
    'regenerateInviteCode',
    'setWakeShareOptIn',
  ];
  return Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => mockReal(name, ...args)]));
});

const SET: PermissionSet = { viewAlarm: true, editAlarm: false, viewWake: true };

// [함수 이름, 부르는 인자] — 인자가 그대로 real로 가야 함 (date 포함)
const CASES: [keyof typeof api, unknown[]][] = [
  ['listFriends', []],
  ['listFriendRequests', []],
  ['acceptFriend', ['u1']],
  ['listGroups', ['2026-10-20']],
  ['getGroupSummary', ['g1', '2026-10-20']],
  ['getGroup', ['g1', '2026-10-20']],
  ['getFriendGrant', ['u1']],
  ['listRelations', []],
  ['getRelation', ['group:g1']],
  ['getShareSettings', ['friend:u1']],
  ['saveShareSettings', ['group:g1', SET]],
  ['getReceived', ['group:g1']],
  ['getMemberWake', ['g1', 'u1', '2026-10-20']],
  ['getSharedAlarms', ['u1']],
  ['setSharedAlarmEnabled', ['u1', 'ap1', false]],
  ['shiftSharedAlarm', ['u1', 'ap1', -5]],
  ['getShareLog', []],
  ['sendWakePing', ['u1']],
  ['searchByHandle', ['@etion']],
  ['searchPeople', ['민수']],
  ['myFriendLink', [true]],
  ['openFriendLink', ['ABCDEFGH2345']],
  ['sendFriendRequest', ['u1']],
  ['createGroup', ['스터디']],
  ['joinGroupByCode', ['ABCD1234']],
  ['regenerateInviteCode', ['g1']],
  ['setWakeShareOptIn', ['g1', true]],
];

const fns = { ...api } as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
const call = (name: keyof typeof api, args: unknown[]) => fns[name](...args);

beforeEach(() => {
  mockIsMock = true;
  mockReal.mockClear();
});

describe('api.ts 가짜 · 실데이터 나누기 (친구 · 그룹)', () => {
  it.each(CASES)('실데이터 모드면 %s를 real로 그대로 넘김', async (name, args) => {
    mockIsMock = false;
    await expect(call(name, args)).resolves.toBe(`real:${name}`);
    expect(mockReal).toHaveBeenCalledTimes(1);
    expect(mockReal).toHaveBeenCalledWith(name, ...args);
  });

  it('실데이터 읽기 실패는 가짜로 바꾸지 않고 그대로 던짐 (화면이 LoadError로 보여 줌)', async () => {
    mockIsMock = false;
    mockReal.mockRejectedValueOnce(new Error('network'));
    await expect(api.listGroups()).rejects.toThrow('network');
  });

  // 가짜 모드에서 도는 함수는 목업 데이터를 만지므로 읽기만 + 실패해도 되는 쓰기 몇 개로 확인
  it('가짜 모드면 real을 부르지 않고 목업 데이터에서 읽음', async () => {
    const reads: [keyof typeof api, unknown[]][] = [
      ['listFriends', []],
      ['listFriendRequests', []],
      ['listGroups', ['2026-10-20']],
      ['getGroupSummary', ['cap', '2026-10-20']],
      ['getGroup', ['cap', '2026-10-20']],
      ['getFriendGrant', ['sy']],
      ['listRelations', []],
      ['getRelation', ['group:cap']],
      ['getShareSettings', ['group:cap']],
      ['getReceived', ['group:cap']],
      ['getMemberWake', ['cap', 'sy', '2026-10-20']],
      ['getSharedAlarms', ['sy']],
      ['getShareLog', []],
      ['searchByHandle', ['@etion']],
      ['searchPeople', ['수연']],
      ['myFriendLink', []],
      ['openFriendLink', ['ABCDEFGH2345']],
    ];
    for (const [name, args] of reads) await call(name, args);
    expect(mockReal).not.toHaveBeenCalled();
  });

  it('가짜 모드의 쓰기도 real을 부르지 않음 (깨우기 · 권한 저장 · 공유 알람 바꾸기)', async () => {
    await api.sendWakePing('sy');
    await api.saveShareSettings('group:cap', SET);
    await expect(api.setSharedAlarmEnabled('sy', 's1', false)).resolves.toEqual({ notified: true });
    await expect(api.shiftSharedAlarm('sy', 's1', 5)).resolves.toEqual({ notified: true });
    expect(mockReal).not.toHaveBeenCalled();
  });
});
