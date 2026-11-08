import { describe, expect, it } from '@jest/globals';

import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';

import { createGroup, getGroup, joinGroupByCode, listGroups, listRelations, cancelFriendRequest, declineFriend, listFriendRequests, listFriends, listSentRequests, myFriendLink, openFriendLink, regenerateInviteCode, removeFriend, searchByHandle, searchPeople, sendFriendRequest, setWakeShareOptIn } from '../api';

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

describe('그룹 만들기 · 참여 · 초대 코드 · 동의 (가짜)', () => {
  it('만들면 내가 만든 그룹으로 목록에 들어가고 초대 코드가 생김', async () => {
    const before = (await listGroups()).length;
    const created = await createGroup('  스터디  ');
    expect((await listGroups()).length).toBe(before + 1);
    const group = await getGroup(created.id);
    expect(group).toMatchObject({ name: '스터디', inviteCode: created.inviteCode, isOwner: true, wakeShareOptIn: false });
    expect(group?.members.map((m) => m.isMe)).toEqual([true]);
    expect(group?.since).toMatch(/^\d{4}년 \d{1,2}월부터 함께하는 중$/);
    // F03 관계 고르기에도 나옴
    expect((await listRelations()).some((r) => r.id === `group:${created.id}`)).toBe(true);
  });

  it('이름이 비었거나 50자를 넘으면 만들 수 없음', async () => {
    await expect(createGroup('  ')).rejects.toThrow(UserError);
    await expect(createGroup('가'.repeat(51))).rejects.toThrow(UserError);
  });

  it('코드로 참여: 맞는 코드면 그 그룹 id, 틀리면 이유 (대소문자 · 공백은 맞춤)', async () => {
    const cap = await getGroup('cap');
    await expect(joinGroupByCode(` ${cap?.inviteCode.toLowerCase()} `)).resolves.toBe('cap');
    await expect(joinGroupByCode('NOPE-0000')).rejects.toThrow(new UserError('초대 코드가 맞지 않아요'));
    await expect(joinGroupByCode(' ')).rejects.toThrow(UserError);
  });

  it('초대 코드 다시 만들기: 만든 사람(내가 만든 그룹)만, 옛 코드는 더 못 씀', async () => {
    const { id, inviteCode } = await createGroup('코드 시험');
    const next = await regenerateInviteCode(id);
    expect(next).not.toBe(inviteCode);
    expect((await getGroup(id))?.inviteCode).toBe(next);
    await expect(joinGroupByCode(inviteCode)).rejects.toThrow(UserError);
    await expect(joinGroupByCode(next)).resolves.toBe(id);
    await expect(regenerateInviteCode('cap')).rejects.toThrow(UserError); // 캡스톤팀은 내가 만든 그룹이 아님
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
