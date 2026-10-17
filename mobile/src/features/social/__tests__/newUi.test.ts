import { describe, expect, it } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { createGroup, getGroup, joinGroupByCode, listGroups, listRelations, regenerateInviteCode, searchByHandle, sendFriendRequest, setWakeShareOptIn } from '../api';

// 새 UI용 함수의 가짜 구현 — 화면이 생기면 가짜 모드에서도 같은 이름으로 바로 쓰게 (실데이터는 real.test.ts)
describe('아이디 검색 · 친구 요청 (가짜)', () => {
  it('@ · 대소문자와 상관없이 목업 사람을 찾고, 나와의 관계를 알려 줌', async () => {
    expect(await searchByHandle(' @ETION ')).toMatchObject({ person: { id: 'sy', handle: '@etion' }, relation: 'FRIEND' });
    expect((await searchByHandle('june'))?.relation).toBe('RECEIVED'); // 범준은 나에게 요청을 보낸 상태
    expect(await searchByHandle('nobody')).toBeNull();
    expect(await searchByHandle('me')).toBeNull(); // 나 자신은 안 나옴
  });

  it('요청을 보내면 보낸 요청으로 보이고, 이미 있는 사이 · 나 자신에게는 보낼 수 없음', async () => {
    expect((await searchByHandle('@vmgfh'))?.relation).toBe('FRIEND');
    await expect(sendFriendRequest('jh')).rejects.toThrow(UserError); // 이미 친구
    await expect(sendFriendRequest('bj')).rejects.toThrow(UserError); // 이미 받은 요청
    await expect(sendFriendRequest('me')).rejects.toThrow(UserError);
    await expect(sendFriendRequest('nobody')).rejects.toThrow(UserError);
    await sendFriendRequest('mom');
    await expect(sendFriendRequest('mom')).rejects.toThrow(UserError); // 두 번은 안 됨
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
