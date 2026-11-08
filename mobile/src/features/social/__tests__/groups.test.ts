import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { createFake } from '../__fixtures__/fakeSupabase';
import { friends, groups, GROUP, JIHYEONG, JUNSEONG, ME, members, perms, profiles, SUYEON } from '../__fixtures__/seed';
import { CODE_EXPIRED, CODE_NOT_FOUND, GROUP_FULL, expiresLabel, inviteShareMessage, GROUP_NOT_MEMBER, GROUP_TOO_MANY, cleanCode, groupNameProblem, leaveText, previewProblem, removeMemberText } from '../groupTexts';
import { MESSAGE_GONE } from '../relationMessages';
import * as real from '../real';

// 친구 5장 앱 층 — 그룹 만들기 · 코드 미리보기 → 참여 · 받은 초대 · 직접 초대 · 코드 시트 · 이름 · 나가기 · 내보내기 · 알림 끄기
//   (시험케이스 5-01 · 5-05 · 5-08 ~ 5-14 · 5-17 · 5-25 · 5-27 · 5-30 · 5-34 · 5-41 · 5-46 · 5-49)
//   서버 판단(20명 · 10개 · 만료 · 횟수 제한 · 그룹장 없음 권한)은 DB 함수가 함 — 여기서는 호출 모양 · 상태 → 문구 · 목록 모양을 확인
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
const calls = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

beforeEach(() => {
  mockFake.reset();
  mockFake.answer('friends.select', ok(friends));
  mockFake.answer('groups.select', ok(groups));
  mockFake.answer('group_members.select', ok(members));
  mockFake.answer('sharing_permissions.select', ok(perms));
  mockFake.answerRpc('get_public_profiles', ok(publicProfiles));
  mockFake.answerRpc('get_group_wake_status', ok([]));
});

describe('이름 · 코드 다듬기 (5-01 · 5-13)', () => {
  it('이름: 앞뒤 공백을 자르고 1~50자, 이모지 · 같은 이름은 허용', () => {
    expect(groupNameProblem('  스터디  ')).toBeNull();
    expect(groupNameProblem('가'.repeat(50))).toBeNull();
    expect(groupNameProblem('가'.repeat(51))).not.toBeNull();
    expect(groupNameProblem('   ')).not.toBeNull();
    expect(groupNameProblem('')).not.toBeNull();
    expect(groupNameProblem('😀'.repeat(50))).toBeNull(); // 글자 수로 셈(이모지 하나 = 1자)
  });

  it('코드: 공백은 빼고 대문자로, O/0은 그대로(보정 없음)', () => {
    expect(cleanCode(' ab cd\n12o0 ')).toBe('ABCD12O0');
  });
});

describe('createGroup — 5-01 · 5-03', () => {
  it('이름을 다듬어 만들고 코드 · 만료를 돌려줌, 구성원 행은 앱이 안 씀(트리거)', async () => {
    mockFake.answer('groups.insert', ok({ group_id: 'g-new', invite_code: 'ZZZZ9999', invite_code_expires_at: '2026-10-26T00:00:00.000Z' }));
    await expect(real.createGroup('  스터디 모임 ')).resolves.toEqual({ id: 'g-new', inviteCode: 'ZZZZ9999', expiresAt: new Date('2026-10-26T00:00:00.000Z') });
    const [op] = mockFake.opsOf('groups', 'insert');
    expect(op.payload).toEqual({ group_name: '스터디 모임', owner_id: ME });
    expect(mockFake.opsOf('group_members', 'insert')).toHaveLength(0);
  });

  it('이름이 비었거나 51자면 DB에 안 감', async () => {
    await expect(real.createGroup('   ')).rejects.toThrow(UserError);
    await expect(real.createGroup('가'.repeat(51))).rejects.toThrow(UserError);
    expect(mockFake.opsOf('groups', 'insert')).toHaveLength(0);
  });

  it('한 사람 10개 상한(54000)은 이유 문구, 통신 오류(5-05)는 그대로 던짐', async () => {
    mockFake.answer('groups.insert', { data: null, error: { code: '54000', message: '그룹은 10개까지 참여할 수 있음' } });
    await expect(real.createGroup('열한 번째')).rejects.toThrow(new UserError(GROUP_TOO_MANY));
    mockFake.answer('groups.insert', { data: null, error: { code: 'XX000', message: 'offline' } });
    const r = real.createGroup('오프라인');
    await expect(r).rejects.toMatchObject({ message: 'offline' });
    await expect(r).rejects.not.toBeInstanceOf(UserError);
  });
});

describe('previewGroupByCode — 5-08 · 5-11 · 5-12 · 5-14 · 5-34', () => {
  it('코드를 다듬어 미리보기 함수에 맡기고 이름 · 인원 · 가득 · 이미 참여 · 만료일을 돌려줌', async () => {
    mockFake.answerRpc(
      'preview_group_by_code',
      ok({ status: 'FOUND', group_name: '캡스톤팀', member_count: 20, full: true, already_joined: false, expires_at: '2026-10-26T00:00:00.000Z', retry_after_seconds: 0 }),
    );
    await expect(real.previewGroupByCode(' abcd 1234 ')).resolves.toEqual({
      status: 'FOUND',
      name: '캡스톤팀',
      memberCount: 20,
      full: true,
      alreadyJoined: false,
      expiresAt: new Date('2026-10-26T00:00:00.000Z'),
    });
    expect(calls('preview_group_by_code')).toEqual([{ name: 'preview_group_by_code', args: { p_code: 'ABCD1234' } }]);
  });

  it('미리보기는 참여하지 않음 — join_group을 안 부름', async () => {
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'FOUND', group_name: 'x', member_count: 1, full: false, already_joined: false, expires_at: null }));
    await real.previewGroupByCode('ABCD1234');
    expect(calls('join_group')).toHaveLength(0);
  });

  it('없는 · 만료 · 잠시 뒤 다시 — 상태 그대로 돌려주고 문구가 따로', async () => {
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'NOT_FOUND' }));
    const nf = await real.previewGroupByCode('ZZZZZZZZ');
    expect(nf).toEqual({ status: 'NOT_FOUND' });
    expect(previewProblem(nf)).toBe(CODE_NOT_FOUND);
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'EXPIRED' }));
    expect(previewProblem(await real.previewGroupByCode('ZZZZZZZZ'))).toBe(CODE_EXPIRED);
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'LIMIT', retry_after_seconds: 1800 }));
    const limit = await real.previewGroupByCode('ZZZZZZZZ');
    expect(limit).toEqual({ status: 'LIMIT', retryAfterSeconds: 1800 });
    expect(previewProblem(limit)).toBe('잠시 뒤 다시 해 주세요(30분)');
  });

  it('빈 코드는 서버에 가지 않고, 통신 오류 · 모르는 상태는 UserError가 아니게 던짐', async () => {
    await expect(real.previewGroupByCode('   ')).rejects.toThrow(UserError);
    expect(calls('preview_group_by_code')).toHaveLength(0);
    mockFake.answerRpc('preview_group_by_code', { data: null, error: { code: 'XX000', message: 'offline' } });
    await expect(real.previewGroupByCode('ABCD1234')).rejects.toMatchObject({ message: 'offline' });
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'WHAT' }));
    await expect(real.previewGroupByCode('ABCD1234')).rejects.toThrow();
  });
});

describe('joinGroup — 5-09 · 5-10 · 5-31', () => {
  it('[공유]는 p_wake_share true, [나중에]는 false로 코드와 함께 맡김', async () => {
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await expect(real.joinGroup(' abcd1234 ', true)).resolves.toEqual({ id: GROUP, already: false });
    await real.joinGroup('ABCD1234', false);
    expect(calls('join_group').map((c) => c.args)).toEqual([
      { p_code: 'ABCD1234', p_wake_share: true },
      { p_code: 'ABCD1234', p_wake_share: false },
    ]);
  });

  it('이미 참여 중이면 그 그룹 id와 already', async () => {
    mockFake.answerRpc('join_group', ok({ status: 'ALREADY_JOINED', group_id: GROUP }));
    await expect(real.joinGroup('ABCD1234', false)).resolves.toEqual({ id: GROUP, already: true });
  });

  it('실패 상태는 이유 문구', async () => {
    const fail = async (status: string, extra: object = {}) => {
      mockFake.answerRpc('join_group', ok({ status, group_id: null, ...extra }));
      return real.joinGroup('ABCD1234', true);
    };
    await expect(fail('NOT_FOUND')).rejects.toThrow(new UserError(CODE_NOT_FOUND));
    await expect(fail('EXPIRED')).rejects.toThrow(new UserError(CODE_EXPIRED));
    await expect(fail('FULL')).rejects.toThrow(new UserError(GROUP_FULL));
    await expect(fail('TOO_MANY_GROUPS')).rejects.toThrow(new UserError(GROUP_TOO_MANY));
    await expect(fail('LIMIT', { retry_after_seconds: 3600 })).rejects.toThrow(new UserError('잠시 뒤 다시 해 주세요(1시간)'));
  });

  it('참여하면 읽어 둔 그룹 목록을 비움', async () => {
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await real.listGroups();
    await real.joinGroup('ABCD1234', false);
    await real.listGroups();
    expect(mockFake.opsOf('groups', 'select')).toHaveLength(2);
  });
});

describe('받은 초대 — 5-25 · 5-30 · 5-31', () => {
  it('my_group_invites를 카드 모양으로: 그룹 이름 · 인원 · 초대한 사람, 최근 순 그대로', async () => {
    mockFake.answerRpc(
      'my_group_invites',
      ok([{ group_id: 'g2', group_name: '독서 모임', member_count: 4, invited_by: SUYEON, invited_by_nickname: '수연', invited_at: '2026-10-18T01:00:00.000Z' }]),
    );
    await expect(real.listGroupInvites()).resolves.toEqual([
      { groupId: 'g2', name: '독서 모임', initial: '독', memberCount: 4, invitedByName: '수연', invitedAt: new Date('2026-10-18T01:00:00.000Z') },
    ]);
  });

  it('[참여] = accept_group_invite(+ 동의 선택), 참여한 그룹 id', async () => {
    mockFake.answerRpc('accept_group_invite', ok({ status: 'JOINED', group_id: 'g2' }));
    await expect(real.acceptGroupInvite('g2', true)).resolves.toEqual({ id: 'g2', already: false });
    expect(calls('accept_group_invite')).toEqual([{ name: 'accept_group_invite', args: { p_group_id: 'g2', p_wake_share: true } }]);
    mockFake.answerRpc('accept_group_invite', ok({ status: 'ALREADY_JOINED', group_id: 'g2' }));
    await expect(real.acceptGroupInvite('g2', false)).resolves.toEqual({ id: 'g2', already: true });
  });

  it('수락 실패: 초대가 사라짐 · 가득 · 10개', async () => {
    mockFake.answerRpc('accept_group_invite', ok({ status: 'GONE' }));
    await expect(real.acceptGroupInvite('g2', false)).rejects.toThrow(new UserError(MESSAGE_GONE));
    mockFake.answerRpc('accept_group_invite', ok({ status: 'FULL' }));
    await expect(real.acceptGroupInvite('g2', false)).rejects.toThrow(new UserError(GROUP_FULL));
    mockFake.answerRpc('accept_group_invite', ok({ status: 'TOO_MANY_GROUPS' }));
    await expect(real.acceptGroupInvite('g2', false)).rejects.toThrow(new UserError(GROUP_TOO_MANY));
  });

  it('[거절] = 내 INVITED 행만 지움 (알림 없음), 이미 없으면 이유', async () => {
    mockFake.answer('group_members.delete', ok([{ group_member_id: 'm1' }]));
    await real.declineGroupInvite('g2');
    const [op] = mockFake.opsOf('group_members', 'delete');
    expect(op.filters).toEqual([
      ['eq', 'group_id', 'g2'],
      ['eq', 'user_id', ME],
      ['eq', 'invite_status', 'INVITED'],
    ]);
    mockFake.answer('group_members.delete', ok([]));
    await expect(real.declineGroupInvite('g2')).rejects.toThrow(new UserError(MESSAGE_GONE));
  });
});

describe('직접 초대 — 5-27', () => {
  it('invite_to_group에 그룹 · 친구를 맡김, 이미 초대한 사람도 성공', async () => {
    mockFake.answerRpc('invite_to_group', ok({ status: 'INVITED' }));
    await expect(real.inviteToGroup(GROUP, SUYEON)).resolves.toBe('INVITED');
    expect(calls('invite_to_group')).toEqual([{ name: 'invite_to_group', args: { p_group_id: GROUP, p_user_id: SUYEON } }]);
    mockFake.answerRpc('invite_to_group', ok({ status: 'ALREADY_INVITED' }));
    await expect(real.inviteToGroup(GROUP, SUYEON)).resolves.toBe('ALREADY_INVITED');
  });

  it('이미 멤버 · 초대할 수 없는 사람은 이유 문구', async () => {
    mockFake.answerRpc('invite_to_group', ok({ status: 'ALREADY_MEMBER' }));
    await expect(real.inviteToGroup(GROUP, JIHYEONG)).rejects.toThrow(new UserError('이미 그룹에 있어요'));
    mockFake.answerRpc('invite_to_group', ok({ status: 'NOT_FOUND' }));
    await expect(real.inviteToGroup(GROUP, OTHER)).rejects.toThrow(new UserError('초대할 수 없는 사람이에요'));
    mockFake.answerRpc('invite_to_group', ok({ status: 'SELF' }));
    await expect(real.inviteToGroup(GROUP, ME)).rejects.toThrow(UserError);
  });

  it('+ 초대 친구 목록: 내 친구만, 이미 멤버 · 초대 중은 표시', async () => {
    mockFake.answer('group_members.select', ok([...members.filter((m) => m.user_id !== SUYEON), { ...members[0], user_id: SUYEON, invite_status: 'INVITED', joined_at: null }]));
    mockFake.answer(
      'friends.select',
      ok([
        ...friends,
        { friend_id: 'f4', requester_id: ME, addressee_id: OTHER, status: 'ACCEPTED', requested_at: '2026-10-04T00:00:00.000Z' },
      ]),
    );
    mockFake.answerRpc('get_public_profiles', ok([...publicProfiles, { user_id: OTHER, nickname: '민아', handle: 'mina_1', profile_image_url: null }]));
    const list = await real.listInvitableFriends(GROUP);
    expect(list.map((f) => [f.person.name, f.state])).toEqual([
      ['민아', 'NONE'],
      ['수연', 'INVITED'],
      ['지형', 'MEMBER'],
    ]);
    expect(list.every((f) => f.person.handle)).toBe(true);
  });
});

describe('코드 시트 — 5-17 · 5-49', () => {
  it('열 때 my_group_code: 코드 + 만료일(서버가 만료됐으면 새 코드로 바꿔 줌)', async () => {
    mockFake.answerRpc('my_group_code', ok({ status: 'OK', code: 'QWERTY23', expires_at: '2026-10-25T09:00:00.000Z' }));
    await expect(real.getGroupCode(GROUP)).resolves.toEqual({ code: 'QWERTY23', expiresAt: new Date('2026-10-25T09:00:00.000Z') });
    expect(calls('my_group_code')).toEqual([{ name: 'my_group_code', args: { p_group_id: GROUP } }]);
    mockFake.answerRpc('my_group_code', ok({ status: 'NOT_FOUND' }));
    await expect(real.getGroupCode(GROUP)).rejects.toThrow(new UserError(GROUP_NOT_MEMBER));
  });

  it('[새 코드]: 멤버 누구나, 새 코드를 만든 뒤 시트가 쓸 코드 + 만료일을 다시 읽음', async () => {
    mockFake.answerRpc('regenerate_invite_code', ok('NEWCODE1'));
    mockFake.answerRpc('my_group_code', ok({ status: 'OK', code: 'NEWCODE1', expires_at: '2026-10-25T09:00:00.000Z' }));
    await expect(real.regenerateInviteCode(GROUP)).resolves.toEqual({ code: 'NEWCODE1', expiresAt: new Date('2026-10-25T09:00:00.000Z') });
    expect(calls('regenerate_invite_code')).toEqual([{ name: 'regenerate_invite_code', args: { p_group_id: GROUP } }]);
  });

  it('참여 중이 아니면(42501) 이유 문구 — 그룹장 얘기는 없음', async () => {
    mockFake.answerRpc('regenerate_invite_code', { data: null, error: { code: '42501', message: 'x' } });
    await expect(real.regenerateInviteCode(GROUP)).rejects.toThrow(new UserError(GROUP_NOT_MEMBER));
  });
});

describe('G02 메뉴 — 이름 바꾸기 · 나가기 · 내보내기 · 알림 끄기 (5-18 · 5-19 · 5-21 · 5-46)', () => {
  it('이름 바꾸기: 다듬은 이름을 그 그룹 행에만, 빈 이름 · 51자는 DB에 안 감, 바뀐 행이 없으면 이유', async () => {
    mockFake.answer('groups.update', ok([{ group_id: GROUP }]));
    await real.renameGroup(GROUP, '  새 이름 ');
    const [op] = mockFake.opsOf('groups', 'update');
    expect(op.payload).toEqual({ group_name: '새 이름' });
    expect(op.filters).toEqual([['eq', 'group_id', GROUP]]);
    await expect(real.renameGroup(GROUP, '  ')).rejects.toThrow(UserError);
    await expect(real.renameGroup(GROUP, '가'.repeat(51))).rejects.toThrow(UserError);
    expect(mockFake.opsOf('groups', 'update')).toHaveLength(1);
    mockFake.answer('groups.update', ok([]));
    await expect(real.renameGroup(GROUP, '새 이름')).rejects.toThrow(new UserError(GROUP_NOT_MEMBER));
  });

  it('나가기: 내 JOINED 행을 LEFT로만 (그룹 삭제 · 코드 교체는 서버가), 바뀐 행이 없으면 이유', async () => {
    mockFake.answer('group_members.update', ok([{ group_member_id: 'm1' }]));
    await real.leaveGroup(GROUP);
    const [op] = mockFake.opsOf('group_members', 'update');
    expect(op.payload).toEqual({ invite_status: 'LEFT' });
    expect(op.filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['eq', 'user_id', ME],
      ['eq', 'invite_status', 'JOINED'],
    ]);
    mockFake.answer('group_members.update', ok([]));
    await expect(real.leaveGroup(GROUP)).rejects.toThrow(new UserError(MESSAGE_GONE));
  });

  it('내보내기: 그 사람의 구성원 행을 지움 (코드 교체 · 권한 삭제는 서버가), 이미 없으면 이유', async () => {
    mockFake.answer('group_members.delete', ok([{ group_member_id: 'm2' }]));
    await real.removeGroupMember(GROUP, JUNSEONG);
    const [op] = mockFake.opsOf('group_members', 'delete');
    expect(op.filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['eq', 'user_id', JUNSEONG],
    ]);
    mockFake.answer('group_members.delete', ok([]));
    await expect(real.removeGroupMember(GROUP, JUNSEONG)).rejects.toThrow(new UserError(MESSAGE_GONE));
  });

  it('내보내기로 나 자신은 지우지 않음 (나가기를 쓰게)', async () => {
    await expect(real.removeGroupMember(GROUP, ME)).rejects.toThrow(UserError);
    expect(mockFake.opsOf('group_members', 'delete')).toHaveLength(0);
  });

  it('알림 끄기 · 켜기: 내 행의 notifications_off만', async () => {
    mockFake.answer('group_members.update', ok([{ group_member_id: 'm1' }]));
    await real.setGroupNotificationsOff(GROUP, true);
    await real.setGroupNotificationsOff(GROUP, false);
    const ops = mockFake.opsOf('group_members', 'update');
    expect(ops.map((o) => o.payload)).toEqual([{ notifications_off: true }, { notifications_off: false }]);
    expect(ops[0].filters).toEqual([
      ['eq', 'group_id', GROUP],
      ['eq', 'user_id', ME],
      ['eq', 'invite_status', 'JOINED'],
    ]);
    mockFake.answer('group_members.update', ok([]));
    await expect(real.setGroupNotificationsOff(GROUP, true)).rejects.toThrow(new UserError(GROUP_NOT_MEMBER));
  });

  it('쓰기 뒤에는 읽어 둔 그룹을 비움', async () => {
    mockFake.answer('group_members.update', ok([{ group_member_id: 'm1' }]));
    await real.listGroups();
    await real.leaveGroup(GROUP);
    await real.listGroups();
    expect(mockFake.opsOf('groups', 'select')).toHaveLength(2);
  });
});

describe('G01 · G02 보이는 값 — 5-04 · 5-30 · 5-41 · 5-46', () => {
  it('그룹 카드 인원은 참여 중만 (초대 중 · 나간 사람은 안 셈)', async () => {
    mockFake.answer('group_members.select', ok([...members, { ...members[0], user_id: OTHER, invite_status: 'INVITED', joined_at: null }, { ...members[0], user_id: 'left-1', invite_status: 'LEFT' }]));
    const [g] = await real.listGroups();
    expect(g.memberCount).toBe(4);
  });

  it('상세: "함께한 기간"은 내 참여 일시, 그룹장 · 코드 칸은 없음, 알림 끄기 값, 멤버는 @아이디', async () => {
    mockFake.answer('group_members.select', ok(members.map((m) => (m.user_id === ME ? { ...m, notifications_off: true } : m))));
    const g = await real.getGroup(GROUP);
    expect(g).toMatchObject({ id: GROUP, name: '캡스톤팀', since: '2026년 4월부터 함께하는 중', wakeShareOptIn: true, notificationsOff: true });
    expect(g).not.toHaveProperty('isOwner');
    expect(g).not.toHaveProperty('inviteCode');
    expect(g?.members.find((m) => m.person.id === SUYEON)?.person.handle).toBe('@demo_suyeon');
  });

  it('내 참여 일시가 비어 있으면 그룹 만든 날로', async () => {
    mockFake.answer('group_members.select', ok(members.map((m) => (m.user_id === ME ? { ...m, joined_at: null } : m))));
    expect((await real.getGroup(GROUP))?.since).toBe('2026년 3월부터 함께하는 중');
  });
});

describe('확인창 문구 — 5-19 · 5-44 · 5-47', () => {
  it('코드 시트 만료일 · 공유 글 (5-07 · 5-49)', () => {
    expect(expiresLabel(new Date('2026-11-15T01:00:00.000Z'))).toBe('11/15까지');
    expect(inviteShareMessage('캡스톤팀', 'ABCD2345', '11/15까지')).toBe("Re:Spec 알람 '캡스톤팀' 그룹에 초대해요. 초대 코드: ABCD2345 (11/15까지)");
    expect(inviteShareMessage('캡스톤팀', 'ABCD2345', null)).not.toContain('까지');
  });

  it('나가기: 공동 약속 알람 수 · 마지막 멤버면 그룹이 사라진다고 알림', () => {
    expect(leaveText('캡스톤팀', 2, false)).toEqual({
      title: '캡스톤팀에서 나갈까요?',
      body: '공동 약속 알람 2개도 지워져요.\n다시 들어오려면 새 초대가 필요해요.',
      ok: '나가기',
    });
    expect(leaveText('캡스톤팀', 0, true).body).toBe('내가 마지막 멤버라 그룹이 사라져요.\n다시 들어오려면 새 초대가 필요해요.');
  });

  it('내보내기: 코드가 바뀌고 상대에게 알리지 않음', () => {
    expect(removeMemberText('준성')).toEqual({ title: '준성님을 내보낼까요?', body: '그룹 코드가 새로 바뀌어요. 상대에게는 알리지 않아요.', ok: '내보내기' });
  });
});
