import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { calls, filterOf, onCall, resetFake, type FakeCall } from '@/features/records/testing/fakeSupabase';

import { getPendingRoutineSuggestion, getRoutine, ignoreRoutineSuggestion, saveRoutine } from '../real';

// 루틴 제안 (안건 D114) 실데이터 — routine_suggestions 읽기 · 넘김 · 초안(다음 기상 알람) · 저장하면 받아들임
jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>('@/features/records/testing/fakeSupabase').fakeClient }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-19T00:30:00Z') })); // 10/19(월) 9:30 KST
jest.mock('@/lib/alarmSync', () => ({ reconcile: async () => ({}) }));

const SID = '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f';
const NEW_ROUTINE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const row = {
  suggestion_id: SID,
  cause: 'OVERSLEEP',
  title: '일어나자마자 2단계',
  reason: '최근 아침 7번 중 4번, 기상 알람 뒤 평균 18분 만에 일어났어요',
  draft: {
    goal: '다시 잠들지 않기',
    days: [1, 3, 4],
    steps: [
      { name: '물 한 잔', minutes: 2, alarm: false, offsetFromWake: 0, at: null },
      { name: '창문 열고 불 켜기', minutes: 3, alarm: true, offsetFromWake: 3, at: null },
    ],
  },
};
const only = (table: string, op?: FakeCall['op']) => calls.filter((c) => c.table === table && (!op || c.op === op));

beforeEach(() => resetFake());

describe('루틴 제안 — 실데이터', () => {
  it('기다리는 제안 하나를 본인 것 · 최근 순으로 읽어 화면 타입으로', async () => {
    onCall(() => ({ data: row }));
    const s = await getPendingRoutineSuggestion();
    expect([s?.id, s?.cause, s?.draft.days]).toEqual([SID, 'OVERSLEEP', [1, 3, 4]]);
    expect([filterOf(calls[0], 'eq', 'user_id')?.[1], filterOf(calls[0], 'eq', 'status')?.[1]]).toEqual(['user-1', 'PENDING']);
  });

  it('넘김 — 기다리는 제안만 IGNORED + 답한 시각', async () => {
    onCall(() => ({ data: null }));
    await ignoreRoutineSuggestion(SID);
    const u = only('routine_suggestions', 'update')[0];
    expect((u.payload as { status: string }).status).toBe('IGNORED');
    expect([filterOf(u, 'eq', 'suggestion_id')?.[1], filterOf(u, 'eq', 'status')?.[1]]).toEqual([SID, 'PENDING']);
  });

  it('초안 — 루틴 요일 중 다음 기상 알람(수 7:15)에서 시작, 이미 답한 제안 · 이상한 번호는 null', async () => {
    onCall((c) => {
      if (c.table === 'routine_suggestions') return { data: row };
      if (c.table === 'alarms') return { data: [{ scheduled_at: '2026-10-19T22:00:00Z' }, { scheduled_at: '2026-10-20T22:15:00Z' }] }; // 화 7:00(요일 밖) · 수 7:15 (KST)
      return undefined;
    });
    const draft = await getRoutine('new', undefined, SID);
    expect([draft?.startMinute, draft?.days, draft?.sourceSuggestion]).toEqual([7 * 60 + 15, ['월', '수', '목'], SID]);
    resetFake();
    onCall(() => ({ data: null }));
    expect(await getRoutine('new', undefined, SID)).toBeNull();
    expect(await getRoutine('new', undefined, 'rs1')).toBeNull();
  });

  it('저장 — 새 루틴은 AI 제안으로 만들고 그 제안을 받아들임(만든 루틴을 붙임)', async () => {
    onCall((c) => {
      if (c.table === 'routines' && c.op === 'insert') return { data: { routine_id: NEW_ROUTINE_ID } };
      if (c.table === 'alarms' && c.op === 'select') return { data: [] };
      if (c.table === 'alarms' && c.op === 'insert') return { data: (c.payload as unknown[]).map((_, i) => ({ alarm_id: `new-${i + 1}` })) };
      return undefined;
    });
    await saveRoutine({
      id: null, title: '일어나자마자 2단계', goal: '다시 잠들지 않기', days: ['월', '수', '목'], startMinute: 435, active: true, sourceJournal: null, sourceSuggestion: SID,
      steps: [{ id: 's1', name: '물 한 잔', minutes: 3, alarm: false }, { id: 's2', name: '창문 열고 불 켜기', minutes: 3, alarm: true }],
    });
    expect((only('routines', 'insert')[0].payload as { origin: string }).origin).toBe('AI_SUGGESTED');
    const u = only('routine_suggestions', 'update')[0];
    expect(u.payload).toMatchObject({ status: 'ACCEPTED', routine_id: NEW_ROUTINE_ID });
    expect(filterOf(u, 'eq', 'status')?.[1]).toBe('PENDING');
  });
});
