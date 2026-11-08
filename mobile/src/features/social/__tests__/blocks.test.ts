import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, groups, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { BLOCK_TEXT, REPORT_REASONS, reportToast, UNBLOCK_TEXT } from '../blockTexts';
import { MESSAGE_GONE } from '../relationMessages';
import * as real from '../real';

// 친구 4장 앱 층 — 차단 · 풀기 · 차단 목록 · 신고 (시험케이스 4-02 · 4-03 · 4-06 · 4-30 · 4-31 · 4-32 · 4-33)
//   서버 판단(양쪽 방향 효과 · 권한 삭제 · 하루 1번)은 DB 함수가 함 — 여기서는 호출 모양 · 상태 → 문구 · 목록 모양 · 안내 글을 확인
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
const GROUP_ID = '10000000-0000-4000-8000-000000000001';
const calls = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
});

describe('blockUser — block_user', () => {
  it('상대 id만 넘김 — 친구가 아니어도 누구나 차단 (4-30)', async () => {
    mockFake.answerRpc('block_user', ok({ status: 'BLOCKED' }));
    await real.blockUser(OTHER);
    expect(calls('block_user')).toEqual([{ name: 'block_user', args: { p_user_id: OTHER } }]);
    expect(mockFake.opsOf('friends', 'update')).toHaveLength(0);
  });

  it('이미 차단한 사람도 성공으로 (ALREADY_BLOCKED)', async () => {
    mockFake.answerRpc('block_user', ok({ status: 'ALREADY_BLOCKED' }));
    await expect(real.blockUser(OTHER)).resolves.toBeUndefined();
  });

  it('나 · 없는 사람은 이유 문구', async () => {
    mockFake.answerRpc('block_user', ok({ status: 'SELF' }));
    await expect(real.blockUser(ME)).rejects.toThrow(new UserError('나는 차단할 수 없어요'));
    mockFake.answerRpc('block_user', ok({ status: 'NOT_FOUND' }));
    await expect(real.blockUser(OTHER)).rejects.toThrow(new UserError('사용자를 찾을 수 없어요'));
  });

  it('차단하면 친구 · 받은 요청이 바뀌므로 읽어 둔 목록을 비움 (4-06 · 4-32)', async () => {
    mockFake.answerRpc('block_user', ok({ status: 'BLOCKED' }));
    await real.listFriendRequests();
    await real.blockUser(JUNSEONG);
    await real.listFriendRequests();
    expect(mockFake.opsOf('friends', 'select')).toHaveLength(2);
  });

  it('통신 오류 · 모르는 상태는 UserError가 아니게 던짐', async () => {
    mockFake.answerRpc('block_user', { data: null, error: { code: 'XX000', message: 'offline' } });
    const r = real.blockUser(OTHER);
    await expect(r).rejects.toMatchObject({ message: 'offline' });
    await expect(r).rejects.not.toBeInstanceOf(UserError);
    mockFake.answerRpc('block_user', ok({ status: 'WHAT' }));
    await expect(real.blockUser(OTHER)).rejects.toThrow();
  });
});

describe('unblockUser — unblock_user', () => {
  it('풀기: 내 행만, 친구는 복구 안 됨', async () => {
    mockFake.answerRpc('unblock_user', ok({ status: 'UNBLOCKED' }));
    await real.unblockUser(OTHER);
    expect(calls('unblock_user')).toEqual([{ name: 'unblock_user', args: { p_user_id: OTHER } }]);
  });

  it('차단 안 한 사람(GONE)은 "이미 처리됐을 수 있어요"', async () => {
    mockFake.answerRpc('unblock_user', ok({ status: 'GONE' }));
    await expect(real.unblockUser(OTHER)).rejects.toThrow(new UserError(MESSAGE_GONE));
  });
});

describe('listBlocks — my_blocks (4-33)', () => {
  it('닉네임 · 아이디 · 차단한 시각, 서버가 준 순서(새로 차단한 순) 그대로', async () => {
    mockFake.answerRpc(
      'my_blocks',
      ok([
        { user_id: OTHER, nickname: '강범준', profile_image_url: null, handle: 'june', blocked_at: '2026-11-08T05:00:00.123456+00:00' },
        { user_id: SUYEON, nickname: '이수연', profile_image_url: null, handle: 'etion', blocked_at: '2026-11-01T00:00:00+00:00' },
      ]),
    );
    const list = await real.listBlocks();
    expect(list.map((b) => [b.person.id, b.person.name, b.person.handle])).toEqual([
      [OTHER, '강범준', '@june'],
      [SUYEON, '이수연', '@etion'],
    ]);
    expect(list[0].blockedAt).toEqual(new Date('2026-11-08T05:00:00.123Z'));
  });

  it('차단한 사람이 없으면 빈 목록', async () => {
    mockFake.answerRpc('my_blocks', ok([]));
    expect(await real.listBlocks()).toEqual([]);
    mockFake.answerRpc('my_blocks', ok(null));
    expect(await real.listBlocks()).toEqual([]);
  });
});

describe('submitReport — submit_report (4-31)', () => {
  it('대상 종류 · id · 사유 · 한 줄 메모(앞뒤 공백 뗌, 비면 null)를 넘김', async () => {
    mockFake.answerRpc('submit_report', ok({ status: 'REPORTED' }));
    await real.submitReport({ type: 'USER', id: OTHER }, 'NICKNAME', '  이상한 닉네임  ');
    await real.submitReport({ type: 'GROUP', id: GROUP_ID }, 'GROUP_NAME', '   ');
    await real.submitReport({ type: 'USER', id: OTHER }, 'OTHER');
    expect(calls('submit_report').map((c) => c.args)).toEqual([
      { p_target_type: 'USER', p_target_id: OTHER, p_reason: 'NICKNAME', p_note: '이상한 닉네임' },
      { p_target_type: 'GROUP', p_target_id: GROUP_ID, p_reason: 'GROUP_NAME', p_note: null },
      { p_target_type: 'USER', p_target_id: OTHER, p_reason: 'OTHER', p_note: null },
    ]);
  });

  it('메모는 200자까지만 보냄', async () => {
    mockFake.answerRpc('submit_report', ok({ status: 'REPORTED' }));
    await real.submitReport({ type: 'USER', id: OTHER }, 'OTHER', '가'.repeat(250));
    expect((calls('submit_report')[0].args as { p_note: string }).p_note).toHaveLength(200);
  });

  it('REPORTED · ALREADY_REPORTED를 그대로 돌려줌 — 화면이 토스트를 고름', async () => {
    mockFake.answerRpc('submit_report', ok({ status: 'REPORTED' }));
    expect(await real.submitReport({ type: 'USER', id: OTHER }, 'HARASSMENT')).toBe('REPORTED');
    mockFake.answerRpc('submit_report', ok({ status: 'ALREADY_REPORTED' }));
    expect(await real.submitReport({ type: 'USER', id: OTHER }, 'HARASSMENT')).toBe('ALREADY_REPORTED');
  });

  it('INVALID · SELF · NOT_FOUND는 이유 문구', async () => {
    mockFake.answerRpc('submit_report', ok({ status: 'INVALID' }));
    await expect(real.submitReport({ type: 'USER', id: OTHER }, 'GROUP_NAME')).rejects.toThrow(new UserError('신고 내용을 확인해 주세요'));
    mockFake.answerRpc('submit_report', ok({ status: 'SELF' }));
    await expect(real.submitReport({ type: 'USER', id: ME }, 'OTHER')).rejects.toThrow(new UserError('나는 신고할 수 없어요'));
    mockFake.answerRpc('submit_report', ok({ status: 'NOT_FOUND' }));
    await expect(real.submitReport({ type: 'USER', id: OTHER }, 'OTHER')).rejects.toThrow(new UserError('신고할 대상을 찾을 수 없어요'));
  });
});

describe('안내 글 — 초안(11/8) 그대로', () => {
  it('차단 확인: 친구 끊김 · 권한 삭제 · 검색 · 요청 · 초대 · 깨우기 불가 · 같은 그룹은 이름만 · 알리지 않음', () => {
    expect(BLOCK_TEXT.title('이수연')).toBe('이수연님을 차단할까요?');
    expect(BLOCK_TEXT.lines).toEqual([
      '친구가 끊기고 공유한 권한이 모두 사라져요.',
      '서로 검색 · 요청 · 초대 · 깨우기를 할 수 없어요.',
      '같은 그룹에서는 이름만 보이고 기상 상태는 가려져요.',
      '상대에게는 알리지 않아요.',
    ]);
    expect(BLOCK_TEXT.toast).toBe('차단했어요');
  });

  it('풀기 확인: 친구는 새 요청부터, 상대가 나를 차단했다면 그대로', () => {
    expect(UNBLOCK_TEXT.title('강범준')).toBe('강범준님 차단을 풀까요?');
    expect(UNBLOCK_TEXT.body).toBe('풀어도 다시 친구가 되지는 않아요. 친구는 새 요청부터 시작해요. 상대가 나를 차단했다면 서로 안 보이는 상태는 그대로예요.');
  });

  it('신고 사유: 사람 4가지(기타 마지막), 그룹 3가지 — 서버 사유 값 그대로', () => {
    expect(REPORT_REASONS.USER.map((r) => r.value)).toEqual(['HARASSMENT', 'NICKNAME', 'PHOTO', 'OTHER']);
    expect(REPORT_REASONS.GROUP.map((r) => r.value)).toEqual(['GROUP_NAME', 'HARASSMENT', 'OTHER']);
    expect(REPORT_REASONS.USER.map((r) => r.label)).toEqual(['괴롭힘이나 불쾌한 행동', '부적절한 닉네임', '부적절한 사진', '기타']);
    expect(REPORT_REASONS.GROUP.map((r) => r.label)).toEqual(['부적절한 그룹 이름', '괴롭힘이나 불쾌한 행동', '기타']);
  });

  it('신고 토스트: 처음 "신고했어요", 같은 날 다시 "오늘은 이미 신고한 대상이에요"', () => {
    expect(reportToast('REPORTED')).toBe('신고했어요');
    expect(reportToast('ALREADY_REPORTED')).toBe('오늘은 이미 신고한 대상이에요');
  });
});
