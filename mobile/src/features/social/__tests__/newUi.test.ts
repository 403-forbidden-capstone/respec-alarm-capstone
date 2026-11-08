import { describe, expect, it } from '@jest/globals';

import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';

import { acceptGroupInvite, createGroup, declineGroupInvite, getGroup, getGroupCode, inviteToGroup, joinGroup, leaveGroup, listGroupInvites, listGroups, listInvitableFriends, listRelations, previewGroupByCode, removeGroupMember, renameGroup, setGroupNotificationsOff, blockUser, cancelFriendRequest, declineFriend, listBlocks, submitReport, unblockUser, listFriendRequests, listFriends, listSentRequests, myFriendLink, openFriendLink, regenerateInviteCode, removeFriend, searchByHandle, searchPeople, sendFriendRequest, setWakeShareOptIn } from '../api';

// 새 UI용 함수의 가짜 구현 — 화면이 생기면 가짜 모드에서도 같은 이름으로 바로 쓰게 (실데이터는 real.test.ts)
describe('아이디 검색 · 친구 요청 (가짜)', () => {
  it('@ · 대소문자와 상관없이 목업 사람을 찾고, 나와의 관계를 알려 줌', async () => {
    expect(await searchByHandle(' @ETION ')).toMatchObject({ status: 'FOUND', person: { id: 'sy', handle: '@etion' }, relation: 'FRIEND' });
    expect(await searchByHandle('june')).toMatchObject({ status: 'FOUND', relation: 'RECEIVED' }); // 범준은 나에게 요청을 보낸 상태
    expect(await searchByHandle('nobody')).toEqual({ status: 'NOT_FOUND' });
    expect(await searchByHandle('ab')).toEqual({ status: 'NOT_FOUND' }); // 아이디 모양이 아님
  });

  it('통합 검색: 아이디 정확 일치 + 이름 부분 일치(친구 · 같은 그룹)', async () => {
    const byHandle = await searchPeople('@etion');
    expect(byHandle.rows[0]).toMatchObject({ person: { id: 'sy' }, relation: 'FRIEND', via: 'HANDLE' });
    const byName = await searchPeople('수연');
    expect(byName.rows.map((h) => h.person.id)).toContain('sy');
    expect(byName.rows.every((h) => h.via !== 'HANDLE')).toBe(true);
    expect((await searchPeople('찾을수없는이름')).notFound).toBe(true);
    expect((await searchPeople('  ')).notFound).toBe(false);
  });

  it('요청을 보내면 보낸 요청으로 보이고, 이미 있는 사이 · 나 자신에게는 보낼 수 없음', async () => {
    expect(await searchByHandle('@vmgfh')).toMatchObject({ relation: 'FRIEND' });
    await expect(sendFriendRequest('jh')).rejects.toThrow(UserError); // 이미 친구
    await expect(sendFriendRequest('bj')).rejects.toThrow(UserError); // 이미 받은 요청
    await expect(sendFriendRequest('me')).rejects.toThrow(UserError);
    await expect(sendFriendRequest('nobody')).rejects.toThrow(UserError);
    expect(await sendFriendRequest('mom')).toBe('SENT');
    await expect(sendFriendRequest('mom')).rejects.toThrow(UserError); // 두 번은 안 됨
  });
});

describe('친구 요청 거절 · 취소 · 끊기 (가짜)', () => {
  it('보낸 요청 목록에 보이고, 취소하면 사라져 다시 보낼 수 있음', async () => {
    await sendFriendRequest('dad');
    expect((await listSentRequests()).map((p) => p.id)).toContain('dad');
    await cancelFriendRequest('dad');
    expect((await listSentRequests()).map((p) => p.id)).not.toContain('dad');
    await expect(cancelFriendRequest('dad')).rejects.toThrow(UserError); // 이미 없음
    expect(await sendFriendRequest('dad')).toBe('SENT');
    await cancelFriendRequest('dad');
  });

  it('받은 요청을 거절하면 목록에서 사라짐', async () => {
    expect((await listFriendRequests()).map((p) => p.id)).toContain('bj');
    await declineFriend('bj');
    expect((await listFriendRequests()).map((p) => p.id)).not.toContain('bj');
    await expect(declineFriend('bj')).rejects.toThrow(UserError);
  });

  it('친구를 끊으면 목록에서 빠지고, 이미 끊은 사람은 이유 문구', async () => {
    expect((await listFriends()).map((f) => f.person.id)).toContain('jh');
    await removeFriend('jh');
    expect((await listFriends()).map((f) => f.person.id)).not.toContain('jh');
    await expect(removeFriend('jh')).rejects.toThrow(UserError);
  });
});

describe('친구 링크 (가짜)', () => {
  it('내 링크: 7일짜리 토큰, 다시 만들면 다른 토큰', async () => {
    const a = await myFriendLink();
    expect(a.token).toMatch(/^[A-Z2-9]{12}$/);
    expect(a.expiresAt.getTime()).toBe(now().getTime() + 7 * 24 * 60 * 60 * 1000);
    expect((await myFriendLink()).token).toBe(a.token);
    expect((await myFriendLink(true)).token).not.toBe(a.token);
  });

  it('착지: 내 링크는 SELF, 다시 만들기 전 옛 링크는 EXPIRED, 남의 링크는 그 사람과 관계', async () => {
    const mine = await myFriendLink();
    expect(await openFriendLink(mine.token)).toMatchObject({ status: 'SELF' });
    const renewed = await myFriendLink(true);
    expect(await openFriendLink(mine.token)).toEqual({ status: 'EXPIRED' });
    expect(await openFriendLink(renewed.token)).toMatchObject({ status: 'SELF' });
    expect(await openFriendLink('FRIENDSY00001')).toMatchObject({ status: 'OK', person: { id: 'sy' }, relation: 'FRIEND' });
    expect(await openFriendLink('FRIENDDAD0001')).toMatchObject({ status: 'OK', person: { id: 'dad' }, relation: 'NONE' });
    expect(await openFriendLink('NOSUCHLINK000')).toEqual({ status: 'EXPIRED' });
  });
});

describe('차단 · 신고 (가짜)', () => {
  it('차단하면 서로 안 보임: 검색이 "찾을 수 없어요", 받은 요청 · 친구 목록에서 빠지고 차단 목록에 올라감 (4-02 · 4-06 · 4-30)', async () => {
    await blockUser('bj'); // 나에게 요청을 보낸 사람
    expect((await listFriendRequests()).map((p) => p.id)).not.toContain('bj');
    expect(await searchByHandle('june')).toEqual({ status: 'NOT_FOUND' });
    expect((await searchPeople('범준')).notFound).toBe(true);
    await blockUser('dad'); // 아무 사이도 아닌 사람도 차단됨
    expect((await listBlocks()).map((b) => b.person.id)).toEqual(['dad', 'bj']); // 새로 차단한 순
  });

  it('풀면 목록에서 빠지고 다시 검색되지만 친구는 새 요청부터', async () => {
    await unblockUser('bj');
    expect((await listBlocks()).map((b) => b.person.id)).toEqual(['dad']);
    expect(await searchByHandle('june')).toMatchObject({ status: 'FOUND', relation: 'NONE' });
    await expect(unblockUser('bj')).rejects.toThrow(UserError); // 이미 풀었음
    await unblockUser('dad');
  });

  it('신고: 같은 대상은 하루 한 번, 나 자신은 못 함', async () => {
    expect(await submitReport({ type: 'USER', id: 'sy' }, 'NICKNAME', '이상해요')).toBe('REPORTED');
    expect(await submitReport({ type: 'USER', id: 'sy' }, 'PHOTO')).toBe('ALREADY_REPORTED');
    expect(await submitReport({ type: 'GROUP', id: 'cap' }, 'GROUP_NAME')).toBe('REPORTED');
    await expect(submitReport({ type: 'USER', id: 'me' }, 'OTHER')).rejects.toThrow(UserError);
  });
});

describe('그룹 만들기 · 참여 · 초대 코드 · 동의 (가짜)', () => {
  it('만들면 목록에 들어가고 8자 코드 + 7일 만료가 생김, 그룹장 칸은 없음', async () => {
    const before = (await listGroups()).length;
    const created = await createGroup('  스터디  ');
    expect((await listGroups()).length).toBe(before + 1);
    expect(created.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(created.expiresAt).toBeInstanceOf(Date);
    const group = await getGroup(created.id);
    expect(group).toMatchObject({ name: '스터디', wakeShareOptIn: false, notificationsOff: false });
    expect(group).not.toHaveProperty('isOwner');
    expect(group?.members.map((m) => m.isMe)).toEqual([true]);
    expect(group?.since).toMatch(/^\d{4}년 \d{1,2}월부터 함께하는 중$/);
    // F03 관계 고르기에도 나옴
    expect((await listRelations()).some((r) => r.id === `group:${created.id}`)).toBe(true);
  });

  it('이름이 비었거나 50자를 넘으면 만들 수 없음', async () => {
    await expect(createGroup('  ')).rejects.toThrow(UserError);
    await expect(createGroup('가'.repeat(51))).rejects.toThrow(UserError);
  });

  it('코드 미리보기: 내 그룹 · 아직 안 들어간 그룹 · 가득 · 만료 · 없는 코드, 참여는 안 함', async () => {
    const cap = (await getGroupCode('cap')).code;
    expect(await previewGroupByCode(` ${cap.toLowerCase()} `)).toMatchObject({ status: 'FOUND', name: '캡스톤팀', alreadyJoined: true });
    expect(await previewGroupByCode('READ2345')).toMatchObject({ status: 'FOUND', name: '독서 모임', memberCount: 3, full: false, alreadyJoined: false });
    expect(await previewGroupByCode('FULLFULL')).toMatchObject({ status: 'FOUND', full: true });
    expect(await previewGroupByCode('OLDCODE2')).toEqual({ status: 'EXPIRED' });
    expect(await previewGroupByCode('ZZZZZZZZ')).toEqual({ status: 'NOT_FOUND' });
    await expect(previewGroupByCode('  ')).rejects.toThrow(UserError);
    expect((await listGroups()).some((g) => g.name === '독서 모임')).toBe(false); // 미리보기만으로는 안 들어감
  });

  it('코드로 참여: 동의 선택이 저장되고 받은 초대 카드는 사라짐, 이미 참여 중이면 already, 가득 · 만료 · 없는 코드는 이유', async () => {
    await expect(joinGroup('FULLFULL', true)).rejects.toThrow(new UserError('가득 찼어요'));
    await expect(joinGroup('OLDCODE2', true)).rejects.toThrow(new UserError('만료된 코드예요'));
    await expect(joinGroup('ZZZZZZZZ', true)).rejects.toThrow(new UserError('없는 코드예요'));
    expect((await listGroupInvites()).map((i) => i.groupId)).toContain('read');
    await expect(joinGroup(' read 2345 ', true)).resolves.toEqual({ id: 'read', already: false });
    expect((await getGroup('read'))?.wakeShareOptIn).toBe(true);
    expect((await listGroupInvites()).map((i) => i.groupId)).not.toContain('read'); // 5-31 초대 카드 사라짐
    await expect(joinGroup('READ2345', false)).resolves.toEqual({ id: 'read', already: true });
  });

  it('받은 초대: [참여]는 동의를 묻고 들어감, [거절]은 조용히 사라지고 다시 처리하면 이미 처리됨', async () => {
    const invite = (await listGroupInvites()).find((i) => i.groupId === 'run');
    expect(invite).toMatchObject({ name: '아침 러닝', memberCount: 1 });
    await declineGroupInvite('run');
    expect((await listGroupInvites()).map((i) => i.groupId)).not.toContain('run');
    await expect(declineGroupInvite('run')).rejects.toThrow(UserError);
    await expect(acceptGroupInvite('run', false)).rejects.toThrow(UserError);
  });

  it('코드 시트: 8자 코드 + 만료일, [새 코드]를 누르면 코드가 바뀜 (멤버 누구나), 옛 코드는 더 못 씀', async () => {
    const { id, inviteCode } = await createGroup('코드 시험');
    const next = await regenerateInviteCode(id);
    expect(next.code).not.toBe(inviteCode);
    expect((await getGroupCode(id)).code).toBe(next.code);
    expect(await previewGroupByCode(inviteCode)).toEqual({ status: 'NOT_FOUND' });
    expect((await regenerateInviteCode('cap')).code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/); // 만든 사람이 아니어도 됨
  });

  it('G02 메뉴: 이름 바꾸기 · 알림 끄기 · 내보내기(코드가 바뀜) · 나가기', async () => {
    const { id } = await createGroup('메뉴 시험');
    await renameGroup(id, '  새 이름 ');
    expect((await getGroup(id))?.name).toBe('새 이름');
    await expect(renameGroup(id, '  ')).rejects.toThrow(UserError);
    await setGroupNotificationsOff(id, true);
    expect((await getGroup(id))?.notificationsOff).toBe(true);
    await setGroupNotificationsOff(id, false);
    expect((await getGroup(id))?.notificationsOff).toBe(false);
    const before = (await getGroupCode('cap')).code;
    await removeGroupMember('cap', 'js');
    expect((await getGroup('cap'))?.members.map((m) => m.person.id)).not.toContain('js');
    expect((await getGroupCode('cap')).code).not.toBe(before);
    await expect(removeGroupMember('cap', 'me')).rejects.toThrow(UserError);
    await leaveGroup(id);
    expect(await getGroup(id)).toBeNull();
    await expect(leaveGroup(id)).rejects.toThrow(UserError);
  });

  it('직접 초대: 친구만, 이미 멤버는 거절, 두 번 눌러도 성공, 목록에 초대 중 표시', async () => {
    const { id } = await createGroup('초대 시험');
    const before = await listInvitableFriends(id);
    expect(before.every((f) => f.state === 'NONE')).toBe(true);
    const target = before[0].person.id;
    await expect(inviteToGroup(id, target)).resolves.toBe('INVITED');
    await expect(inviteToGroup(id, target)).resolves.toBe('ALREADY_INVITED');
    expect((await listInvitableFriends(id)).find((f) => f.person.id === target)?.state).toBe('INVITED');
    await expect(inviteToGroup(id, 'nobody')).rejects.toThrow(UserError);
    expect((await listInvitableFriends('cap')).filter((f) => f.state === 'MEMBER').length).toBeGreaterThan(0);
  });

  it('기상 공유 동의: 켜고 끄면 그룹 상세에 반영, 참여 중이 아닌 그룹은 이유', async () => {
    expect((await getGroup('cap'))?.wakeShareOptIn).toBe(true); // 목업 그룹은 이미 공유 중
    await setWakeShareOptIn('cap', false);
    expect((await getGroup('cap'))?.wakeShareOptIn).toBe(false);
    await setWakeShareOptIn('cap', true);
    expect((await getGroup('cap'))?.wakeShareOptIn).toBe(true);
    await expect(setWakeShareOptIn('none', true)).rejects.toThrow(UserError);
  });
});
