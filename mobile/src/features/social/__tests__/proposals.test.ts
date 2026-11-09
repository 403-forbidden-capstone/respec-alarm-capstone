import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createFake } from '../__fixtures__/fakeSupabase';
import * as real from '../real';
import { proposalChange, proposalLine } from '../proposalTexts';

// 친구 10장 앱 층 — 받은 제안 카드 · [적용] [무시] · 보낸 쪽 '제안함' '반영됨' (시험케이스 10-04 · 10-05 · 10-06 · 10-15 · 10-17 · 10-23 · 10-24)
//   판정(권한 · ±60분 · 곧 울릴 알람 · 대체 · 만료)은 서버 DB 함수가 함 — 여기서는 호출 모양 · 상태 → 문구 · 적용 뒤 폰 맞추기를 확인
const mockFake = createFake();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFake.client.from(table),
    rpc: (name: string, args?: unknown) => mockFake.client.rpc(name, args),
  },
}));
const mockSyncNow = jest.fn<() => Promise<void>>();
jest.mock('@/lib/alarmSync', () => ({ syncNow: () => mockSyncNow() }));

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  mockFake.reset();
  mockSyncNow.mockReset();
  mockSyncNow.mockResolvedValue(undefined);
});

describe('받은 제안 목록', () => {
  it('my_alarm_proposals 행 → 제안한 사람 · 알람 종류 · 이전 → 새 시각 (늦게 보낸 순 그대로)', async () => {
    mockFake.answerRpc(
      'my_alarm_proposals',
      ok([{ proposal_id: 'p1', alarm_id: 'a1', alarm_type: 'WAKE', proposer_id: 'u1', proposer_nickname: '수연', from_at: '2026-11-09T22:30:00.000Z', to_at: '2026-11-09T22:00:00.000Z', created_at: '2026-11-09T10:00:00.000Z' }]),
    );
    await expect(real.listAlarmProposals()).resolves.toEqual([
      { id: 'p1', proposerName: '수연', kindLabel: '기상', fromAt: new Date('2026-11-09T22:30:00.000Z'), toAt: new Date('2026-11-09T22:00:00.000Z') },
    ]);
  });
});

describe('[적용] · [무시]', () => {
  it('적용하면 서버가 알람 카드를 옮기고, 앱은 폰 예약을 서버 알람에 맞춤 (10-15)', async () => {
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'APPLIED', alarm_ids: ['a1', 'a2'] }));
    await expect(real.respondAlarmProposal('p1', true)).resolves.toBe('APPLIED');
    expect(mockFake.rpcCalls.find((c) => c.name === 'respond_alarm_proposal')?.args).toEqual({ p_proposal_id: 'p1', p_apply: true });
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('폰에 못 걸어도 적용은 그대로 (다음에 앱이 켜질 때 맞춤)', async () => {
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'APPLIED', alarm_ids: ['a1'] }));
    mockSyncNow.mockRejectedValue(new Error('폰 저장소 오류'));
    await expect(real.respondAlarmProposal('p1', true)).resolves.toBe('APPLIED');
  });

  it('무시는 폰을 건드리지 않고 보낸 친구에게 알리지 않음 · 지나간 제안은 EXPIRED (10-마)', async () => {
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'DISMISSED' }));
    await expect(real.respondAlarmProposal('p1', false)).resolves.toBe('DISMISSED');
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'EXPIRED' }));
    await expect(real.respondAlarmProposal('p1', true)).resolves.toBe('EXPIRED');
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('이미 처리된 제안(NOT_FOUND) · ±60분 밖(LIMIT)은 이유를 알림, 모르는 상태는 오류', async () => {
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'NOT_FOUND' }));
    await expect(real.respondAlarmProposal('p1', true)).rejects.toThrow('이미 처리된 제안이에요');
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'LIMIT' }));
    await expect(real.respondAlarmProposal('p1', true)).rejects.toThrow('원래 시각에서 1시간 넘게는 바꿀 수 없어요');
    mockFake.answerRpc('respond_alarm_proposal', ok({ status: 'SOMETHING' }));
    await expect(real.respondAlarmProposal('p1', true)).rejects.toThrow();
  });
});

describe('문구', () => {
  it("보낸 쪽 한 줄 — 대기 · 무시는 '제안함'(무시해도 친구에게는 안 알림), 적용은 '반영됨'", () => {
    const toAt = new Date('2026-11-09T22:00:00.000Z'); // 한국 7:00
    expect(proposalLine({ status: 'PENDING', toAt })).toMatch(/^제안함 · .*7:00/);
    expect(proposalLine({ status: 'DISMISSED', toAt })).toMatch(/^제안함 · .*7:00/);
    expect(proposalLine({ status: 'APPLIED', toAt })).toMatch(/^반영됨 · .*7:00/);
    expect(proposalLine(null)).toBeNull();
  });

  it("받은 카드 본문 '기상 알람 7:30 → 7:00'", () => {
    expect(proposalChange('기상', new Date('2026-11-09T22:30:00.000Z'), new Date('2026-11-09T22:00:00.000Z'))).toMatch(/^기상 알람 .*7:30.* → .*7:00/);
  });
});
