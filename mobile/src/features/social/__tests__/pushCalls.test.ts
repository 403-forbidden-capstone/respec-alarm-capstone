import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, GROUP, groups, members, perms, profiles } from '../__fixtures__/seed';
import { pushBody } from '../real/push';
import * as real from '../real';

// 친구 11장 앱 층 — notify 호출 모양 · 부르는 때 (시험케이스 11-08 · 11-09 · 11-12 · 11-13 · 11-14 · 11-15, 세션약속 11/8 S1 → S2)
//   요청에는 종류별 인자만 (한 사람 = targetUserId, 그룹 = groupId), 본 동작이 끝난 뒤 부르고 실패해도 본 동작은 그대로
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));
const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/lib/edge', () => ({ callEdge: (name: string, body?: Record<string, unknown>) => mockCallEdge(name, body) }));

const ok = (data: unknown) => ({ data, error: null });
const publicProfiles = profiles.map((p) => ({ user_id: p.user_id, nickname: p.nickname, handle: p.handle, profile_image_url: null }));
const OTHER = '99999999-0000-4000-8000-000000000009';
const notifies = () => mockCallEdge.mock.calls.filter(([name]) => name === 'notify').map(([, body]) => body);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // 기다리지 않고 부르는 알림이 끝나도록

beforeEach(() => {
  mockFake.reset();
  mockCallEdge.mockReset();
  mockCallEdge.mockResolvedValue({ sent: 1, failed: 0 });
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
});

describe('요청 본문', () => {
  it('종류별 인자만 — 한 사람 종류는 targetUserId, 그룹 종류는 groupId (제목 · 본문 · data 없음)', () => {
    expect(pushBody({ kind: 'FRIEND_REQUEST', targetUserId: 'u1' })).toEqual({ kind: 'FRIEND_REQUEST', targetUserId: 'u1' });
    expect(pushBody({ kind: 'GROUP_MEMBER_JOINED', groupId: 'g1' })).toEqual({ kind: 'GROUP_MEMBER_JOINED', groupId: 'g1' });
  });

  it('알람 바뀜은 이전 → 새 시각을 ISO 글자로, 둘 다 있을 때만', () => {
    const previousAt = new Date('2026-11-10T22:30:00.000Z');
    const newAt = new Date('2026-11-10T22:25:00.000Z');
    expect(pushBody({ kind: 'ALARM_CHANGED', targetUserId: 'u1', alarmId: 'a1', previousAt, newAt })).toEqual({
      kind: 'ALARM_CHANGED',
      targetUserId: 'u1',
      alarmId: 'a1',
      previousAt: '2026-11-10T22:30:00.000Z',
      newAt: '2026-11-10T22:25:00.000Z',
    });
    expect(pushBody({ kind: 'ALARM_CHANGED', targetUserId: 'u1', previousAt })).toEqual({ kind: 'ALARM_CHANGED', targetUserId: 'u1' });
  });
});

describe('친구 요청 · 수락 알림 (11-12 · 11-13)', () => {
  it('새 요청(REQUESTED)을 보내면 받는 사람에게 FRIEND_REQUEST, 이미 보낸 요청을 다시 눌러도 알림은 안 보냄', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'REQUESTED' }));
    await real.sendFriendRequest(OTHER);
    await settle();
    expect(notifies()).toEqual([{ kind: 'FRIEND_REQUEST', targetUserId: OTHER }]);
    mockCallEdge.mockClear();
    mockFake.answerRpc('send_friend_request', ok({ status: 'ALREADY_REQUESTED' }));
    await real.sendFriendRequest(OTHER);
    await settle();
    expect(notifies()).toEqual([]);
  });

  it('상대가 먼저 보낸 요청이 있어 바로 친구가 되면(ACCEPTED) 상대에게 FRIEND_ACCEPTED', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'ACCEPTED' }));
    await expect(real.sendFriendRequest(OTHER)).resolves.toBe('FRIEND');
    await settle();
    expect(notifies()).toEqual([{ kind: 'FRIEND_ACCEPTED', targetUserId: OTHER }]);
  });

  it('받은 요청을 수락하면 요청한 사람에게 FRIEND_ACCEPTED, 두 번 눌러 온 ALREADY_FRIEND는 안 보냄', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ACCEPTED' }));
    await real.acceptFriend(OTHER);
    await settle();
    expect(notifies()).toEqual([{ kind: 'FRIEND_ACCEPTED', targetUserId: OTHER }]);
    mockCallEdge.mockClear();
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ALREADY_FRIEND' }));
    await real.acceptFriend(OTHER);
    await settle();
    expect(notifies()).toEqual([]);
  });

  it('알림이 실패해도 요청 · 수락은 그대로 성공 (11-20)', async () => {
    mockCallEdge.mockRejectedValue(new Error('Expo 서버 장애'));
    mockFake.answerRpc('send_friend_request', ok({ status: 'REQUESTED' }));
    await expect(real.sendFriendRequest(OTHER)).resolves.toBe('SENT');
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ACCEPTED' }));
    await expect(real.acceptFriend(OTHER)).resolves.toBeUndefined();
  });

  it('요청이 거절된 상황(한도 · 없는 사람)에서는 알림을 부르지 않음', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'NOT_FOUND' }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow();
    await settle();
    expect(notifies()).toEqual([]);
  });
});

describe('새 멤버 알림 (11-14 · 11-15)', () => {
  it('코드로 들어오면(JOINED) 그룹 id만 보냄 — 받는 사람은 서버가 고름', async () => {
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await real.joinGroup('ABCD1234', true);
    await settle();
    expect(notifies()).toEqual([{ kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }]);
  });

  it('초대를 수락해도 같음, 이미 참여 중(ALREADY_JOINED)이면 안 보냄', async () => {
    mockFake.answerRpc('accept_group_invite', ok({ status: 'JOINED', group_id: GROUP }));
    await real.acceptGroupInvite(GROUP, true);
    await settle();
    expect(notifies()).toEqual([{ kind: 'GROUP_MEMBER_JOINED', groupId: GROUP }]);
    mockCallEdge.mockClear();
    mockFake.answerRpc('join_group', ok({ status: 'ALREADY_JOINED', group_id: GROUP }));
    await real.joinGroup('ABCD1234', true);
    await settle();
    expect(notifies()).toEqual([]);
  });

  it('알림이 실패해도 참여는 그대로', async () => {
    mockCallEdge.mockRejectedValue(new Error('오프라인'));
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await expect(real.joinGroup('ABCD1234', true)).resolves.toEqual({ id: GROUP, already: false });
  });
});
