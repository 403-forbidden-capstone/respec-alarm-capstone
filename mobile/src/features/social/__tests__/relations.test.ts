import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, groups, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { MESSAGE_GONE, MESSAGE_FRIEND_LIMIT } from '../relationMessages';
import * as real from '../real';

// 친구 3장 앱 층 — 친구 요청 · 수락 · 거절 · 취소 · 끊기는 friends 표를 직접 쓰지 않고 서버 함수로 (시험케이스 3-01~3-12 · 3-20 · 3-21 · 3-26 · 3-28 · 3-29 · 3-35~3-37)
//   서버 판단(100명 상한 · 횟수 · 동시 요청 · 권한 삭제)은 DB 함수가 함 — 여기서는 호출 모양 · 상태 → 문구 · 목록 모양을 확인
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));

const ok = (data: unknown) => ({ data, error: null });
const publicProfiles = profiles.map((p) => ({ user_id: p.user_id, nickname: p.nickname, handle: p.handle, profile_image_url: null }));
const OTHER = '99999999-0000-4000-8000-000000000009';
const OTHER2 = '99999999-0000-4000-8000-00000000000a';
const calls = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
});

describe('문구', () => {
  it('충돌 · 상한 문구는 논리설계 3장 그대로', () => {
    expect(MESSAGE_GONE).toBe('이미 처리됐을 수 있어요');
    expect(MESSAGE_FRIEND_LIMIT).toBe('친구는 100명까지 만들 수 있어요');
  });
});

describe('sendFriendRequest — send_friend_request', () => {
  it('내 대상 id 하나만 넘기고 friends 표를 직접 쓰지 않음 (3-31 · 3-32)', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'REQUESTED' }));
    await real.sendFriendRequest(OTHER);
    expect(calls('send_friend_request')).toEqual([{ name: 'send_friend_request', args: { p_target_id: OTHER } }]);
    expect(mockFake.opsOf('friends', 'insert')).toHaveLength(0);
  });

  it('REQUESTED · ALREADY_REQUESTED는 보낸 상태(SENT), ACCEPTED · ALREADY_FRIEND는 바로 친구(FRIEND) (3-01 · 3-05 · 3-06 · 3-07)', async () => {
    const expected = { REQUESTED: 'SENT', ALREADY_REQUESTED: 'SENT', ACCEPTED: 'FRIEND', ALREADY_FRIEND: 'FRIEND' } as const;
    for (const [status, relation] of Object.entries(expected)) {
      mockFake.answerRpc('send_friend_request', ok({ status }));
      expect(await real.sendFriendRequest(OTHER)).toBe(relation);
    }
  });

  it('나 · 없는 사람(탈퇴 · 온보딩 전 · 차단 쌍)은 이유 문구 (3-08)', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'SELF' }));
    await expect(real.sendFriendRequest(ME)).rejects.toThrow(new UserError('나에게는 친구 요청을 보낼 수 없어요'));
    mockFake.answerRpc('send_friend_request', ok({ status: 'NOT_FOUND' }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow(new UserError('사용자를 찾을 수 없어요'));
  });

  it('LIMIT: 기다릴 시간, FRIEND_LIMIT: 상한 문구 (3-10 · 3-11 · 3-12)', async () => {
    mockFake.answerRpc('send_friend_request', ok({ status: 'LIMIT', retry_after_seconds: 42 }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow(new UserError('잠시 뒤 다시 해 주세요(42초)'));
    mockFake.answerRpc('send_friend_request', ok({ status: 'LIMIT', retry_after_seconds: 7200 }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow(new UserError('잠시 뒤 다시 해 주세요(2시간)'));
    mockFake.answerRpc('send_friend_request', ok({ status: 'FRIEND_LIMIT' }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow(new UserError(MESSAGE_FRIEND_LIMIT));
  });

  it('통신 오류 · 모르는 상태는 UserError가 아니게 던짐 — 화면이 기본 문구로 (3-30 오프라인)', async () => {
    mockFake.answerRpc('send_friend_request', { data: null, error: { code: 'XX000', message: 'offline' } });
    const r = real.sendFriendRequest(OTHER);
    await expect(r).rejects.toMatchObject({ message: 'offline' });
    await expect(r).rejects.not.toBeInstanceOf(UserError);
    mockFake.answerRpc('send_friend_request', ok({ status: 'WHAT' }));
    await expect(real.sendFriendRequest(OTHER)).rejects.toThrow();
  });
});

describe('acceptFriend — accept_friend_request', () => {
  it('요청한 사람 id만 넘기고 수락 시각은 보내지 않음(서버가 정함) (3-26)', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ACCEPTED' }));
    await real.acceptFriend(JUNSEONG);
    expect(calls('accept_friend_request')).toEqual([{ name: 'accept_friend_request', args: { p_requester_id: JUNSEONG } }]);
    expect(mockFake.opsOf('friends', 'update')).toHaveLength(0);
  });

  it('두 번 눌러 ALREADY_FRIEND가 와도 성공으로 (3-29 더블탭)', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ALREADY_FRIEND' }));
    await expect(real.acceptFriend(JUNSEONG)).resolves.toBeUndefined();
  });

  it('GONE(상대가 취소): "이미 처리됐을 수 있어요" (3-28)', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'GONE' }));
    await expect(real.acceptFriend(JUNSEONG)).rejects.toThrow(new UserError(MESSAGE_GONE));
  });

  it('FRIEND_LIMIT: 상한 문구 (3-12)', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'FRIEND_LIMIT' }));
    await expect(real.acceptFriend(JUNSEONG)).rejects.toThrow(new UserError(MESSAGE_FRIEND_LIMIT));
  });

  it('다음 읽기에서 옛 목록을 쓰지 않게 읽어 둔 값을 비움', async () => {
    mockFake.answerRpc('accept_friend_request', ok({ status: 'ACCEPTED' }));
    await real.listFriends();
    await real.acceptFriend(JUNSEONG);
    await real.listFriends();
    expect(mockFake.opsOf('friends', 'select')).toHaveLength(2);
  });
});

describe('declineFriend · cancelFriendRequest · removeFriend', () => {
  it('거절: decline_friend_request, 취소: cancel_friend_request, 끊기: remove_friend — 행을 직접 지우지 않음 (3-03 · 3-04 · 3-14)', async () => {
    mockFake.answerRpc('decline_friend_request', ok({ status: 'DECLINED' }));
    mockFake.answerRpc('cancel_friend_request', ok({ status: 'CANCELED' }));
    mockFake.answerRpc('remove_friend', ok({ status: 'REMOVED' }));
    await real.declineFriend(JUNSEONG);
    await real.cancelFriendRequest(OTHER);
    await real.removeFriend(SUYEON);
    expect(calls('decline_friend_request')[0].args).toEqual({ p_requester_id: JUNSEONG });
    expect(calls('cancel_friend_request')[0].args).toEqual({ p_addressee_id: OTHER });
    expect(calls('remove_friend')[0].args).toEqual({ p_user_id: SUYEON });
    expect(mockFake.opsOf('friends', 'delete')).toHaveLength(0);
  });

  it('GONE이면 "이미 처리됐을 수 있어요" — 화면이 새로 고침', async () => {
    mockFake.answerRpc('decline_friend_request', ok({ status: 'GONE' }));
    mockFake.answerRpc('cancel_friend_request', ok({ status: 'GONE' }));
    mockFake.answerRpc('remove_friend', ok({ status: 'GONE' }));
    await expect(real.declineFriend(JUNSEONG)).rejects.toThrow(new UserError(MESSAGE_GONE));
    await expect(real.cancelFriendRequest(OTHER)).rejects.toThrow(new UserError(MESSAGE_GONE));
    await expect(real.removeFriend(SUYEON)).rejects.toThrow(new UserError(MESSAGE_GONE));
  });

  it('모르는 상태 · 통신 오류는 던짐', async () => {
    mockFake.answerRpc('remove_friend', ok({ status: 'WHAT' }));
    await expect(real.removeFriend(SUYEON)).rejects.toThrow();
    mockFake.answerRpc('remove_friend', { data: null, error: { code: 'XX000', message: 'offline' } });
    await expect(real.removeFriend(SUYEON)).rejects.toMatchObject({ message: 'offline' });
  });
});

describe('listSentRequests — 보낸 요청 (3-01 · 3-03 · 3-04)', () => {
  it('내가 보낸 대기 요청만, 최근 보낸 순', async () => {
    mockFake.answer(
      'friends.select',
      ok([
        ...friends,
        { friend_id: 'fa', requester_id: ME, addressee_id: OTHER, status: 'PENDING', requested_at: '2026-10-05T00:00:00.000Z' },
        { friend_id: 'fb', requester_id: ME, addressee_id: OTHER2, status: 'PENDING', requested_at: '2026-10-09T00:00:00.000Z' },
      ]),
    );
    const sent = await real.listSentRequests();
    expect(sent.map((p) => p.id)).toEqual([OTHER2, OTHER]);
  });

  it('보낸 요청이 없으면 빈 목록', async () => {
    expect(await real.listSentRequests()).toEqual([]);
  });
});

describe('받은 요청 · 친구 목록 (3-36 · 3-37)', () => {
  it('받은 요청이 30개여도 끊지 않고 최신 순으로 전부', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      friend_id: `r${i}`,
      requester_id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      addressee_id: ME,
      status: 'PENDING',
      requested_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    mockFake.answer('friends.select', ok(many));
    expect(await real.listFriendRequests()).toHaveLength(30);
  });

  it('받는 쪽 요청 카드는 닉네임 · 아이디만 (집 · 준비시간 없음)', async () => {
    const [p] = await real.listFriendRequests();
    expect(Object.keys(p).sort()).toEqual(['handle', 'id', 'initial', 'name', 'short']);
  });
});
