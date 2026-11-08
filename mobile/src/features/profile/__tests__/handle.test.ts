import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake } from '@/features/social/__fixtures__/fakeSupabase';
import { UserError } from '@/lib/errors';

import { changeMyHandle, resetOnboarding } from '../api';
import { handleChangeMessage, handleHint, nextChangeLabel } from '../handle';

// 친구 2장 아이디 바꾸기 — 앱이 profiles에 직접 쓰지 않고 change_my_handle(DB 함수)만 부름 (시험케이스 2-04 · 2-05 · 2-07 · 2-25 · 2-30 · 2-50)
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => mockFake.reset());

describe('changeMyHandle', () => {
  it('앞뒤 공백 · 맨 앞 @ · 대문자를 정리해 change_my_handle에 넘김 (2-05 KIM_01 → kim_01)', async () => {
    mockFake.answerRpc('change_my_handle', ok({ status: 'OK', handle: 'kim_01', next_change_at: null }));
    await changeMyHandle(' @KIM_01 ');
    expect(mockFake.rpcCalls).toEqual([{ name: 'change_my_handle', args: { p_handle: 'kim_01' } }]);
    expect(mockFake.ops).toHaveLength(0); // profiles를 직접 쓰지 않음 (2장부터 42501)
  });

  it('OK: 저장된 아이디와 다음 변경 가능 시각(없으면 null)', async () => {
    mockFake.answerRpc('change_my_handle', ok({ status: 'OK', handle: 'kim_01', next_change_at: '2026-12-01T14:00:00+00:00' }));
    const r = await changeMyHandle('kim_01');
    expect(r).toEqual({ status: 'OK', handle: 'kim_01', nextChangeAt: new Date('2026-12-01T14:00:00.000Z') });
    mockFake.answerRpc('change_my_handle', ok({ status: 'OK', handle: 'kim_02', next_change_at: null }));
    expect(await changeMyHandle('kim_02')).toEqual({ status: 'OK', handle: 'kim_02', nextChangeAt: null });
  });

  it('LIMIT: 다음 가능 시각을 돌려줌 (2-04 · 2-25)', async () => {
    mockFake.answerRpc('change_my_handle', ok({ status: 'LIMIT', next_change_at: '2026-12-01T14:00:00.123456+00:00' }));
    expect(await changeMyHandle('kim_01')).toEqual({ status: 'LIMIT', nextChangeAt: new Date('2026-12-01T14:00:00.123Z') });
  });

  it.each(['SAME', 'INVALID', 'RESERVED', 'TAKEN'] as const)('%s: 상태만 돌려줌', async (status) => {
    mockFake.answerRpc('change_my_handle', ok({ status, handle: 'kim_01', next_change_at: null }));
    expect((await changeMyHandle('kim_01')).status).toBe(status);
  });

  it('모르는 상태 · LIMIT인데 시각이 없으면 오류 — 성공한 줄 알고 넘어가지 않게', async () => {
    mockFake.answerRpc('change_my_handle', ok({ status: 'NEW_STATUS' }));
    await expect(changeMyHandle('kim_01')).rejects.toThrow();
    mockFake.answerRpc('change_my_handle', ok({ status: 'LIMIT' }));
    await expect(changeMyHandle('kim_01')).rejects.toThrow();
  });

  it('통신 오류는 원문 그대로 던짐 — 화면이 "저장하지 못했어요"로 바꿈 (2-30 오프라인)', async () => {
    mockFake.answerRpc('change_my_handle', { data: null, error: { code: 'XX000', message: 'Network request failed' } });
    const result = changeMyHandle('kim_01');
    await expect(result).rejects.toMatchObject({ message: 'Network request failed' });
    await expect(result).rejects.not.toBeInstanceOf(UserError);
  });
});

describe('resetOnboarding (개발용)', () => {
  it('profiles를 직접 쓰지 않고 dev_reset_my_data를 부름', async () => {
    mockFake.answerRpc('dev_reset_my_data', ok(null));
    await resetOnboarding('user-1');
    expect(mockFake.rpcCalls).toEqual([{ name: 'dev_reset_my_data', args: undefined }]);
    expect(mockFake.ops).toHaveLength(0);
  });

  it('오류면 던짐', async () => {
    mockFake.answerRpc('dev_reset_my_data', { data: null, error: { code: '42883', message: 'no function' } });
    await expect(resetOnboarding('user-1')).rejects.toBeTruthy();
  });
});

describe('handleChangeMessage — 상태별 안내 문구', () => {
  const at = new Date('2026-12-01T14:00:00.000Z'); // 한국 12월 1일 오후 11시

  it('TAKEN: "이미 있는 아이디예요" (2-07)', () => {
    expect(handleChangeMessage({ status: 'TAKEN' })).toBe('이미 있는 아이디예요');
  });

  it('INVALID · RESERVED: 규칙을 알려 줌 (2-05 · 2-06 · 2-09)', () => {
    expect(handleChangeMessage({ status: 'INVALID' })).toBe('영문 소문자 · 숫자 · _ 3~20자로 써 주세요');
    expect(handleChangeMessage({ status: 'RESERVED' })).toBe('respec_로 시작하는 아이디는 쓸 수 없어요');
  });

  it('LIMIT: "12월 1일 오후 11시부터" 날짜 · 시각 (2-25)', () => {
    expect(handleChangeMessage({ status: 'LIMIT', nextChangeAt: at })).toBe('12월 1일 오후 11시부터 바꿀 수 있어요');
  });

  it('OK · SAME은 오류 문구 없음', () => {
    expect(handleChangeMessage({ status: 'OK', handle: 'a', nextChangeAt: null })).toBeNull();
    expect(handleChangeMessage({ status: 'SAME' })).toBeNull();
  });
});

describe('nextChangeLabel', () => {
  it('분이 있으면 분까지, 한국 시간 기준', () => {
    expect(nextChangeLabel(new Date('2026-12-01T14:30:00.000Z'))).toBe('12월 1일 오후 11시 30분');
    expect(nextChangeLabel(new Date('2026-12-01T00:00:00.000Z'))).toBe('12월 1일 오전 9시');
  });
});

describe('handleHint — 시트 · 줄 안내 (2-50)', () => {
  const now = new Date('2026-11-20T00:00:00.000Z');

  it('바꾼 적 없는 자동 아이디: "바꿔 보세요" 강조, 제한은 안 셈', () => {
    expect(handleHint({ changedAt: null, nextChangeAt: null }, now)).toEqual({ highlight: true, text: '지금은 자동으로 만든 아이디예요. 처음 바꾸는 건 30일 제한에 안 세요', locked: false });
  });

  it('직접 바꾼 뒤 30일 안: 다음 가능 시각, 잠김', () => {
    const r = handleHint({ changedAt: '2026-11-10T00:00:00+00:00', nextChangeAt: '2026-12-10T00:00:00+00:00' }, now);
    expect(r).toEqual({ highlight: false, text: '12월 10일 오전 9시부터 바꿀 수 있어요', locked: true });
  });

  it('직접 바꾼 뒤 30일 지남 · 다음 시각이 비어 있음: 언제든', () => {
    expect(handleHint({ changedAt: '2026-09-01T00:00:00+00:00', nextChangeAt: '2026-10-01T00:00:00+00:00' }, now)).toEqual({ highlight: false, text: '지금 바꿀 수 있어요', locked: false });
    expect(handleHint({ changedAt: '2026-09-01T00:00:00+00:00', nextChangeAt: null }, now)).toEqual({ highlight: false, text: '지금 바꿀 수 있어요', locked: false });
  });
});
