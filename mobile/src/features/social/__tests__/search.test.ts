import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake } from '../__fixtures__/fakeSupabase';
import { JUNSEONG, ME, SUYEON, friends, groups, members, perms, profiles } from '../__fixtures__/seed';
import { friendInviteMessage, friendLinkUrl, linkTokenOf } from '../inviteLink';
import * as real from '../real';
import { relationButton, searchNotice } from '../searchView';
import type { PeopleSearch } from '../types';

// 친구 2장 앱 층 — 아이디 검색 · 이름 검색 · 친구 링크 (시험케이스 2-10~2-14 · 2-18 · 2-22 · 2-29 · 2-31 · 2-34 · 2-37 · 2-39 · 2-43 · 2-46 · 2-47)
//   서버 판단(차단 숨김 · 제한 횟수 · 만료)은 DB 함수가 함 — 여기서는 함수 응답을 화면 값으로 바꾸고 문구를 고르는 일만 확인
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
const prof = (user_id: string, nickname: string, handle: string) => ({ user_id, nickname, handle, profile_image_url: null });
const OTHER = '99999999-0000-4000-8000-000000000009';

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
});

const calledRpc = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

describe('real.searchByHandle — search_by_handle 응답을 화면 값으로', () => {
  it('공백 · @ · 대문자를 정리해 부름 (2-12 · 2-31)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'NOT_FOUND' }));
    await real.searchByHandle('  @Demo_Suyeon ');
    expect(calledRpc('search_by_handle')[0].args).toEqual({ p_query: 'demo_suyeon' });
  });

  it('FOUND: 닉네임 · 아이디와 관계 — 서버 값 REQUEST_SENT · REQUEST_RECEIVED를 앱 값 SENT · RECEIVED로 (2-10)', async () => {
    const found = (relation: string) => ok({ status: 'FOUND', profile: prof(OTHER, '김민수', 'kim_01'), relation });
    const expected = { NONE: 'NONE', REQUEST_SENT: 'SENT', REQUEST_RECEIVED: 'RECEIVED', FRIEND: 'FRIEND' } as const;
    for (const [server, app] of Object.entries(expected)) {
      mockFake.answerRpc('search_by_handle', found(server));
      expect(await real.searchByHandle('kim_01')).toEqual({
        status: 'FOUND',
        person: { id: OTHER, name: '김민수', short: '김민수', initial: '김', handle: '@kim_01' },
        relation: app,
      });
    }
  });

  it('SELF: 내 아이디 (2-13)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'SELF', profile: prof(ME, '나(데모)', 'demo_me') }));
    expect(await real.searchByHandle('demo_me')).toMatchObject({ status: 'SELF', person: { id: ME, handle: '@demo_me' } });
  });

  it('NOT_FOUND: 없음 · 탈퇴 · 차단 · 온보딩 전이 모두 같은 값 (2-14 · 2-34)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'NOT_FOUND' }));
    expect(await real.searchByHandle('nobody_here')).toEqual({ status: 'NOT_FOUND' });
  });

  it('LIMIT: 몇 초 뒤에 다시 되는지 (2-16 · 2-37)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'LIMIT', retry_after_seconds: 42 }));
    expect(await real.searchByHandle('kim_01')).toEqual({ status: 'LIMIT', retryAfterSeconds: 42 });
  });

  it('아이디 모양이 아니면(짧음 · 한글 · 전각) DB에 묻지 않고 NOT_FOUND — 횟수를 아낌 (2-11 · 2-31)', async () => {
    for (const q of ['ab', '한글아이디', 'ｋｉｍ_０１', ' @ ', '']) expect(await real.searchByHandle(q)).toEqual({ status: 'NOT_FOUND' });
    expect(calledRpc('search_by_handle')).toHaveLength(0);
  });

  it('통신 오류 · 모르는 상태는 던짐 — 못 찾은 것으로 보이지 않게 (2-33)', async () => {
    mockFake.answerRpc('search_by_handle', { data: null, error: { code: '42501', message: '로그인이 필요함' } });
    await expect(real.searchByHandle('kim_01')).rejects.toMatchObject({ code: '42501' });
    mockFake.answerRpc('search_by_handle', ok({ status: 'WHAT' }));
    await expect(real.searchByHandle('kim_01')).rejects.toThrow();
  });
});

describe('real.searchRelatedByName — 친구 · 같은 그룹 안에서 이름 검색', () => {
  const row = (user_id: string, nickname: string, handle: string, relation: 'FRIEND' | 'GROUP') => ({ user_id, nickname, handle, profile_image_url: null, relation });

  it('앞뒤 공백을 떼고 부름 (2-46)', async () => {
    mockFake.answerRpc('search_related_by_name', ok([]));
    await real.searchRelatedByName('  민수 ');
    expect(calledRpc('search_related_by_name')[0].args).toEqual({ p_query: '민수' });
  });

  it('빈 검색어 · 30자 넘는 검색어는 DB에 묻지 않고 빈 결과', async () => {
    expect(await real.searchRelatedByName('   ')).toEqual([]);
    expect(await real.searchRelatedByName('가'.repeat(31))).toEqual([]);
    expect(calledRpc('search_related_by_name')).toHaveLength(0);
  });

  it('친구는 FRIEND, 같은 그룹만 있는 사람은 관계 없음 → 친구 요청 (2-39 · 2-46)', async () => {
    mockFake.answerRpc(
      'search_related_by_name',
      ok([row(SUYEON, '김민수', 'demo_suyeon', 'FRIEND'), row(OTHER, '김민수', 'minsu_2', 'GROUP')]),
    );
    const hits = await real.searchRelatedByName('민수');
    expect(hits.map((h) => [h.person.id, h.relation, h.via])).toEqual([
      [SUYEON, 'FRIEND', 'FRIEND'],
      [OTHER, 'NONE', 'GROUP'],
    ]);
    expect(hits[0].person.handle).toBe('@demo_suyeon'); // 동명이인은 아이디로 구분 (2-29)
    expect(hits[1].person.handle).toBe('@minsu_2');
  });

  it('같은 그룹이면서 요청이 오간 사람은 그 상태 그대로 — [친구 요청]을 또 누르게 하지 않음', async () => {
    mockFake.answerRpc('search_related_by_name', ok([row(JUNSEONG, '준성', 'demo_junseong', 'GROUP')]));
    const [hit] = await real.searchRelatedByName('준성'); // 시드: 준성이 나에게 보낸 요청이 대기
    expect(hit.relation).toBe('RECEIVED');
  });
});

describe('real.searchPeople — 아이디 정확 일치가 먼저, 이름 검색을 뒤에', () => {
  const rel = (user_id: string, nickname: string, handle: string, relation: 'FRIEND' | 'GROUP') => ({ user_id, nickname, handle, profile_image_url: null, relation });

  it('빈 검색어면 아무것도 안 부름', async () => {
    const r = await real.searchPeople('   ');
    expect(r).toEqual({ rows: [], self: null, limitSeconds: null, notFound: false });
    expect(mockFake.rpcCalls.filter((c) => c.name !== 'get_public_profiles')).toHaveLength(0);
  });

  it('이름만 넣으면(한글) 이름 검색만 부름 — 아이디 검색 횟수를 안 씀', async () => {
    mockFake.answerRpc('search_related_by_name', ok([rel(OTHER, '김민수', 'minsu_2', 'GROUP')]));
    const r = await real.searchPeople('민수');
    expect(calledRpc('search_by_handle')).toHaveLength(0);
    expect(r.rows.map((h) => h.person.id)).toEqual([OTHER]);
    expect(r.notFound).toBe(false);
  });

  it('아이디 모양이면 둘 다 부르고 아이디 정확 일치를 맨 앞에, 같은 사람은 한 번만', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'FOUND', profile: prof(SUYEON, '수연', 'demo_suyeon'), relation: 'FRIEND' }));
    mockFake.answerRpc('search_related_by_name', ok([rel(OTHER, '수연이', 'suyeon_2', 'GROUP'), rel(SUYEON, '수연', 'demo_suyeon', 'FRIEND')]));
    const r = await real.searchPeople(' @Suyeon ');
    expect(calledRpc('search_by_handle')[0].args).toEqual({ p_query: 'suyeon' });
    expect(calledRpc('search_related_by_name')[0].args).toEqual({ p_query: 'Suyeon' });
    expect(r.rows.map((h) => h.person.id)).toEqual([SUYEON, OTHER]);
  });

  it('내 아이디로 찾으면 self만 채움 (2-13)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'SELF', profile: prof(ME, '나(데모)', 'demo_me') }));
    const r = await real.searchPeople('demo_me');
    expect(r.self).toMatchObject({ id: ME });
    expect(r.rows).toEqual([]);
    expect(r.notFound).toBe(false);
  });

  it('제한에 걸리면 몇 초인지 알리고, 이름 검색 결과는 그대로 보여 줌 (2-37)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'LIMIT', retry_after_seconds: 30 }));
    mockFake.answerRpc('search_related_by_name', ok([rel(OTHER, 'demo', 'x_user', 'GROUP')]));
    const r = await real.searchPeople('demo');
    expect(r.limitSeconds).toBe(30);
    expect(r.rows).toHaveLength(1);
    expect(r.notFound).toBe(false);
  });

  it('아무것도 없으면 notFound (2-14 · 2-15 · 2-18)', async () => {
    mockFake.answerRpc('search_by_handle', ok({ status: 'NOT_FOUND' }));
    mockFake.answerRpc('search_related_by_name', ok([]));
    expect(await real.searchPeople('nobody_here')).toEqual({ rows: [], self: null, limitSeconds: null, notFound: true });
  });
});

describe('searchView — 결과 문구 · 버튼', () => {
  const base: PeopleSearch = { rows: [], self: null, limitSeconds: null, notFound: false };
  const person = { id: 'u', name: '수연', short: '수연', initial: '수', handle: '@etion' };

  it('못 찾음: "찾을 수 없어요" + 카톡 초대 (2-14 · 2-18)', () => {
    expect(searchNotice({ ...base, notFound: true })).toEqual({ text: '찾을 수 없어요', invite: true });
  });

  it('제한: "잠시 뒤 다시 해 주세요(n초)" — 찾을 수 없어요와 다른 문구, 초대 안 권함 (2-37)', () => {
    expect(searchNotice({ ...base, limitSeconds: 42 })).toEqual({ text: '잠시 뒤 다시 해 주세요(42초)', invite: false });
  });

  it('내 아이디: "내 아이디예요" (2-13)', () => {
    expect(searchNotice({ ...base, self: person })).toEqual({ text: '내 아이디예요', invite: false });
  });

  it('결과가 있으면 문구 없음', () => {
    expect(searchNotice({ ...base, rows: [{ person, relation: 'NONE', via: 'HANDLE' }] })).toBeNull();
  });

  it('상태 버튼: 관계 없음 → [친구 요청], 보냄 → 눌러도 아무 일 없는 "요청 보냄", 받음 → [수락], 친구 → "친구"', () => {
    expect(relationButton('NONE')).toEqual({ label: '친구 요청', action: 'request' });
    expect(relationButton('SENT')).toEqual({ label: '요청 보냄', action: 'none' });
    expect(relationButton('RECEIVED')).toEqual({ label: '수락', action: 'accept' });
    expect(relationButton('FRIEND')).toEqual({ label: '친구', action: 'none' });
  });
});

describe('친구 링크 — my_friend_link · open_friend_link', () => {
  it('내 링크: 없거나 만료면 서버가 새로 만듦, 다시 만들기는 p_renew (2-19 · 2-21)', async () => {
    mockFake.answerRpc('my_friend_link', ok({ token: 'ABCDEFGH2345', expires_at: '2026-11-15T03:00:00.123456+00:00' }));
    expect(await real.myFriendLink()).toEqual({ token: 'ABCDEFGH2345', expiresAt: new Date('2026-11-15T03:00:00.123Z') });
    expect(calledRpc('my_friend_link')[0].args).toEqual({ p_renew: false });
    await real.myFriendLink(true);
    expect(calledRpc('my_friend_link')[1].args).toEqual({ p_renew: true });
  });

  it('착지 OK: 프로필과 관계 — 요청은 아직 안 보냄 (2-19 · 2-51)', async () => {
    mockFake.answerRpc('open_friend_link', ok({ status: 'OK', profile: prof(SUYEON, '수연', 'demo_suyeon'), relation: 'NONE' }));
    expect(await real.openFriendLink('  abcdefgh2345 ')).toEqual({
      status: 'OK',
      person: { id: SUYEON, name: '수연', short: '수연', initial: '수', handle: '@demo_suyeon' },
      relation: 'NONE',
    });
    expect(calledRpc('open_friend_link')[0].args).toEqual({ p_token: 'abcdefgh2345' });
    expect(mockFake.opsOf('friends', 'insert')).toHaveLength(0);
  });

  it('착지: 이미 친구면 relation FRIEND (2-43), 요청이 오간 사이는 SENT · RECEIVED', async () => {
    mockFake.answerRpc('open_friend_link', ok({ status: 'OK', profile: prof(SUYEON, '수연', 'demo_suyeon'), relation: 'FRIEND' }));
    expect(await real.openFriendLink('T')).toMatchObject({ status: 'OK', relation: 'FRIEND' });
    mockFake.answerRpc('open_friend_link', ok({ status: 'OK', profile: prof(SUYEON, '수연', 'demo_suyeon'), relation: 'REQUEST_SENT' }));
    expect(await real.openFriendLink('T')).toMatchObject({ relation: 'SENT' });
  });

  it('착지 SELF: "내 링크예요" (2-22), EXPIRED: 없는 · 옛 · 만료 · 탈퇴 · 차단이 모두 같은 값 (2-21 · 2-40~2-42)', async () => {
    mockFake.answerRpc('open_friend_link', ok({ status: 'SELF', profile: prof(ME, '나(데모)', 'demo_me') }));
    expect(await real.openFriendLink('T')).toMatchObject({ status: 'SELF', person: { id: ME } });
    mockFake.answerRpc('open_friend_link', ok({ status: 'EXPIRED' }));
    expect(await real.openFriendLink('T')).toEqual({ status: 'EXPIRED' });
  });

  it('빈 링크 글자는 DB에 묻지 않고 EXPIRED', async () => {
    expect(await real.openFriendLink('   ')).toEqual({ status: 'EXPIRED' });
    expect(calledRpc('open_friend_link')).toHaveLength(0);
  });

  it('통신 오류 · 모르는 상태는 던짐 — 만료로 잘못 보이지 않게', async () => {
    mockFake.answerRpc('open_friend_link', { data: null, error: { message: 'offline' } });
    await expect(real.openFriendLink('T')).rejects.toMatchObject({ message: 'offline' });
    mockFake.answerRpc('open_friend_link', ok({ status: 'WHAT' }));
    await expect(real.openFriendLink('T')).rejects.toThrow();
  });
});

describe('inviteLink — 링크 주소 · 초대 메시지', () => {
  it('주소는 /invite?t=토큰, 토큰은 앞뒤 공백을 떼고 대문자로', () => {
    expect(friendLinkUrl('ABCDEFGH2345', 'https://example.test')).toBe('https://example.test/invite?t=ABCDEFGH2345');
    expect(linkTokenOf(' abcdefgh2345 ')).toBe('ABCDEFGH2345');
    expect(linkTokenOf(undefined)).toBe('');
    expect(linkTokenOf(['ABC', 'DEF'])).toBe('ABC'); // 같은 이름이 여러 번 오면 첫 값
  });

  it('메시지에 닉네임 + 아이디 (2-44), 링크가 있으면 같이', () => {
    expect(friendInviteMessage({ nickname: '지형', handle: 'vmgfh' })).toBe('지형님이 Re:Spec 알람에서 친구가 되고 싶어 해요.\n아이디: @vmgfh');
    expect(friendInviteMessage({ nickname: '지형', handle: 'vmgfh', url: 'https://example.test/invite?t=ABC' })).toBe(
      '지형님이 Re:Spec 알람에서 친구가 되고 싶어 해요.\n아이디: @vmgfh\nhttps://example.test/invite?t=ABC',
    );
  });
});
