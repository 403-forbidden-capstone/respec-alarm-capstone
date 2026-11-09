import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError } from '@/lib/edge';

import { deleteMyAccount, getDeleteSummary, isAccountGone } from '../api';
import { DELETE_FIRST, DELETE_SECOND, DELETION_MAIL, DELETION_PAGE, deleteSummaryLines } from '../texts';

// 친구 12장 앱 층 — 확인 문구 · 두 번 확인 · 웹 삭제 요청 안내 (시험케이스 12-20 · 12-21 · 12-25 · 12-26, 세션약속 `my_account_delete_summary` · `account-delete`)
//   삭제 자체(모든 그룹 나가기 · 마지막 멤버면 그룹 삭제 · 공동 약속 만든 사람 비움 · 계정 삭제)는 서버 몫 — 여기서는 호출 모양 · 문구를 확인
const mockRpc = jest.fn<(name: string) => Promise<{ data: unknown; error: Error | null }>>();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (name: string) => mockRpc(name) } }));
const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/lib/edge', () => {
  const actual = jest.requireActual<typeof import('@/lib/edge')>('@/lib/edge');
  return { ...actual, callEdge: (name: string, body?: Record<string, unknown>) => mockCallEdge(name, body) };
});

beforeEach(() => {
  mockRpc.mockReset();
  mockCallEdge.mockReset();
});

describe('확인 문구 (12-25)', () => {
  it('나갈 그룹 · 마지막 멤버라 사라질 그룹 · 남을 공동 약속 · 친구 · 되돌릴 수 없어요', () => {
    const lines = deleteSummaryLines({ groupsLeaving: 2, groupsDisappearing: 1, groupAppointmentsStaying: 3, friends: 5 });
    expect(lines).toEqual([
      '그룹 2개에서 나가요.',
      '그중 내가 마지막 멤버라 사라질 그룹이 1개예요.',
      "내가 만든 공동 약속 3개는 남고, 만든 사람은 '알 수 없음'으로 보여요.",
      '친구 5명과 연결이 끊겨요.',
      '내 알람 · 기록 · 일정 · 공유 권한이 모두 지워지고 되돌릴 수 없어요.',
    ]);
  });

  it('0인 줄은 빼고 되돌릴 수 없다는 줄은 항상 남김', () => {
    expect(deleteSummaryLines({ groupsLeaving: 0, groupsDisappearing: 0, groupAppointmentsStaying: 0, friends: 0 })).toEqual([
      '내 알람 · 기록 · 일정 · 공유 권한이 모두 지워지고 되돌릴 수 없어요.',
    ]);
  });

  it('확인은 두 번 — 첫 확인에 영향 요약, 두 번째에 되돌릴 수 없다는 한 번 더 (12-20 · 12-21)', () => {
    const first = DELETE_FIRST({ groupsLeaving: 1, groupsDisappearing: 0, groupAppointmentsStaying: 0, friends: 2 });
    expect(first.message).toContain('친구 2명');
    expect(first.title).not.toBe(DELETE_SECOND.title);
    expect(DELETE_SECOND.message).toContain('다시 돌아올 수 없어요');
  });
});

describe('요약 읽기', () => {
  it('my_account_delete_summary 한 줄 → 나갈 그룹 · 사라질 그룹 · 남을 약속 · 친구 수 (배열이든 한 줄이든)', async () => {
    mockRpc.mockResolvedValue({ data: [{ groups_leaving: 2, groups_disappearing: 1, group_appointments_staying: 3, friends: 5 }], error: null });
    await expect(getDeleteSummary()).resolves.toEqual({ groupsLeaving: 2, groupsDisappearing: 1, groupAppointmentsStaying: 3, friends: 5 });
    expect(mockRpc).toHaveBeenCalledWith('my_account_delete_summary');
    mockRpc.mockResolvedValue({ data: { friends: 1 }, error: null });
    await expect(getDeleteSummary()).resolves.toEqual({ groupsLeaving: 0, groupsDisappearing: 0, groupAppointmentsStaying: 0, friends: 1 });
  });

  it('못 읽으면 던짐 (화면은 삭제를 시작하지 않음)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('rpc') });
    await expect(getDeleteSummary()).rejects.toThrow('rpc');
  });

  it('줄이 없거나 비어 있으면 0으로 읽지 않고 던짐 (영향을 모른 채 삭제로 가지 않게)', async () => {
    for (const data of [null, [], undefined]) {
      mockRpc.mockResolvedValue({ data, error: null });
      await expect(getDeleteSummary()).rejects.toThrow('요약 줄이 없어요');
    }
  });
});

describe('삭제 호출', () => {
  it('account-delete에 요청 본문 없이(본인만, 사용자 id를 보내지 않음) 한 번 부르고 결과를 돌려줌 (12-01)', async () => {
    mockCallEdge.mockResolvedValue({ deleted: true, groups_left: 2, groups_deleted: 1, group_appointments_kept: 3 });
    await expect(deleteMyAccount()).resolves.toEqual({ groupsLeft: 2, groupsDeleted: 1, groupAppointmentsKept: 3 });
    expect(mockCallEdge).toHaveBeenCalledWith('account-delete', {});
  });

  it('deleted가 true가 아니면 성공으로 보지 않음 · 서버 오류는 그대로 던짐(이 기기는 그대로, 다시 누르면 이어서 끝냄)', async () => {
    mockCallEdge.mockResolvedValue({ deleted: false });
    await expect(deleteMyAccount()).rejects.toThrow();
    mockCallEdge.mockRejectedValue(new EdgeError('NETWORK'));
    await expect(deleteMyAccount()).rejects.toBeInstanceOf(EdgeError);
  });
});

describe('웹 삭제 요청 안내 (12-26)', () => {
  it('로그인 없이 보는 안내 — 보낼 내용(가입 이메일 · 아이디) · 30일 안 처리, 폼 없음', () => {
    expect(DELETION_PAGE.sendItems).toEqual(['가입한 이메일', '앱에서 쓰는 아이디(설정에서 볼 수 있어요)']);
    expect(DELETION_PAGE.timing).toContain('30일 안에');
    expect(DELETION_PAGE.timing).toContain('가입한 이메일에서 보낸 메일만');
  });

  it('팀 메일 주소는 답을 받을 때까지 비워 둠 (그때까지 준비 중 문구)', () => {
    expect(DELETION_MAIL).toBeNull();
    expect(DELETION_PAGE.mailMissing).toBe('메일 주소를 준비하고 있어요.');
  });
});

describe('삭제 중 로그인 거절', () => {
  it('AUTH_REQUIRED만 이미 지워진 것으로 봄 — 다른 실패는 그대로 실패(이 기기는 그대로)', () => {
    expect(isAccountGone(new EdgeError('AUTH_REQUIRED', { status: 401 }))).toBe(true);
    for (const code of ['NETWORK', 'TIMEOUT', 'INTERNAL', 'FORBIDDEN'] as const) expect(isAccountGone(new EdgeError(code))).toBe(false);
    expect(isAccountGone(new Error('x'))).toBe(false);
  });
});
