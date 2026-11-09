import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';

import { createFake } from '../__fixtures__/fakeSupabase';
import { GROUP, JIHYEONG } from '../__fixtures__/seed';
import { GROUP_ALREADY, previewProblem } from '../groupTexts';
import * as real from '../real';

// 시험케이스 앱 층 중 번호가 시험 이름에 없던 핵심 흐름(그룹 · 친구 요청) 빈 곳 채우기 — 친구_시험대조.md '진짜 없음' 중 jest로 볼 수 있는 것
//   4-18 차단 쌍의 그룹 코드 · 14-22 '이미 참여 중' 문구 · 99-05 오프라인 요청은 쌓아 두지 않음 · 14-28 미리보기 → 참여는 별개 호출
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
jest.mock('@/lib/user', () => ({ requireUserId: async () => '00000000-0000-4000-8000-000000000001' }));

const ok = (data: unknown) => ({ data, error: null });
const calls = (name: string) => mockFake.rpcCalls.filter((c) => c.name === name);

beforeEach(() => {
  mockFake.reset();
});

describe('4-18: 내가 차단한 사람이 있는 그룹의 코드를 넣어도 앱은 막지 않음', () => {
  it('미리보기는 이름 · 인원을 그대로 돌려주고, 차단 표를 읽거나 따로 거르지 않음', async () => {
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'FOUND', group_name: '캡스톤팀', member_count: 3, full: false, already_joined: false, expires_at: null }));
    const p = await real.previewGroupByCode('ABCD1234');
    expect(p).toMatchObject({ status: 'FOUND', name: '캡스톤팀', memberCount: 3 });
    expect(previewProblem(p)).toBeNull();
    expect(mockFake.opsOf('user_blocks')).toHaveLength(0);
  });

  it('참여도 코드만 맡김 — 차단한 사람 id를 보내거나 앱이 먼저 거절하지 않음', async () => {
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await expect(real.joinGroup('ABCD1234', true)).resolves.toEqual({ id: GROUP, already: false });
    expect(calls('join_group')).toEqual([{ name: 'join_group', args: { p_code: 'ABCD1234', p_wake_share: true } }]);
    expect(mockFake.opsOf('user_blocks')).toHaveLength(0);
  });
});

describe('14-22: 코드 입력 결과마다 따로 문구 — 이미 참여 중', () => {
  it('이미 참여 중인 그룹의 미리보기는 alreadyJoined, 참여를 눌러도 같은 그룹 id와 already', async () => {
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'FOUND', group_name: '캡스톤팀', member_count: 3, full: false, already_joined: true, expires_at: null }));
    expect(await real.previewGroupByCode('ABCD1234')).toMatchObject({ status: 'FOUND', alreadyJoined: true });
    mockFake.answerRpc('join_group', ok({ status: 'ALREADY_JOINED', group_id: GROUP }));
    await expect(real.joinGroup('ABCD1234', false)).resolves.toEqual({ id: GROUP, already: true });
    expect(GROUP_ALREADY).toBe('이미 참여 중이에요');
  });
});

describe('14-28: 코드 입력 → 미리보기 → 참여는 따로 호출', () => {
  it('미리보기만으로는 참여 함수가 불리지 않고, 참여는 사용자가 누를 때 코드와 함께 한 번만', async () => {
    mockFake.answerRpc('preview_group_by_code', ok({ status: 'FOUND', group_name: 'x', member_count: 1, full: false, already_joined: false, expires_at: null }));
    mockFake.answerRpc('join_group', ok({ status: 'JOINED', group_id: GROUP }));
    await real.previewGroupByCode('ABCD1234');
    expect(calls('join_group')).toHaveLength(0);
    await real.joinGroup('ABCD1234', false);
    expect(calls('preview_group_by_code')).toHaveLength(1);
    expect(calls('join_group')).toHaveLength(1);
  });
});

describe('99-05: 오프라인에서 친구 요청 · 그룹 참여는 바로 실패, 쌓아 두거나 다시 보내지 않음', () => {
  const offline = { data: null, error: { code: 'XX000', message: 'Network request failed' } };

  it('친구 요청: 한 번 부르고 던짐(UserError 아님 → 화면이 "연결이 없어요" + [다시]), 다시 보내기 · 저장 없음', async () => {
    mockFake.answerRpc('send_friend_request', offline);
    const r = real.sendFriendRequest(JIHYEONG);
    await expect(r).rejects.toMatchObject({ message: 'Network request failed' });
    await expect(r).rejects.not.toBeInstanceOf(UserError);
    expect(calls('send_friend_request')).toHaveLength(1);
    expect(mockFake.ops).toHaveLength(0);
  });

  it('그룹 참여: 한 번 부르고 던짐, 표에 직접 쓰지 않음', async () => {
    mockFake.answerRpc('join_group', offline);
    await expect(real.joinGroup('ABCD1234', false)).rejects.toMatchObject({ message: 'Network request failed' });
    expect(calls('join_group')).toHaveLength(1);
    expect(mockFake.ops).toHaveLength(0);
  });
});
