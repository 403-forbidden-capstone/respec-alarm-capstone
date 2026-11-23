import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { calls, onCall, resetFake, type FakeCall } from '@/features/records/testing/fakeSupabase';

import { checkRoutineStep } from '../real';

// 아침 루틴 음성 진행 — 실데이터 단계 기록: 그 단계 알람에 오늘 확인(출처 VOICE · BUTTON), 이미 확인했거나 알람 없는 단계는 안 씀
jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>('@/features/records/testing/fakeSupabase').fakeClient }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-19T22:10:00Z') }));
jest.mock('@/lib/alarmSync', () => ({ reconcile: async () => ({}) }));

const RID = '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b';
const routineRow = {
  routine_id: RID, title: '일어나자마자 2단계', goal: null, repeat_days: 'MON,WED,THU', is_active: true, daily_journals: null,
  steps: [
    { order: 1, title: '물 한 잔', offset: 440, minutes: 3, is_alarm: false },
    { order: 2, title: '창문 열고 불 켜기', offset: 443, minutes: 3, is_alarm: true },
  ],
};
const reply = (acked: string[]) => (c: FakeCall) => {
  if (c.table === 'routines') return { data: routineRow };
  if (c.table === 'alarms') return { data: [{ alarm_id: 'al-2', step_order: 2 }] };
  if (c.table === 'alarm_events' && c.op === 'select') return { data: acked.map((alarm_id) => ({ alarm_id })) };
  return undefined;
};
const inserts = () => calls.filter((c) => c.table === 'alarm_events' && c.op === 'insert');

beforeEach(() => resetFake());

describe('checkRoutineStep — 실데이터', () => {
  it('알람 있는 단계 → 오늘 확인을 남김(출처 그대로), 끝낸 수가 그 단계까지', async () => {
    onCall(reply([]));
    const p = await checkRoutineStep(RID, 2, 'VOICE');
    expect(inserts()[0].payload).toMatchObject({ alarm_id: 'al-2', user_id: 'user-1', event_type: 'ACKNOWLEDGED', input_source: 'VOICE' });
    expect(p?.done).toBe(2);
  });

  it('알람 없는 단계 · 이미 확인한 단계는 쓰지 않음', async () => {
    onCall(reply([]));
    await checkRoutineStep(RID, 1, 'BUTTON');
    expect(inserts()).toHaveLength(0);
    resetFake();
    onCall(reply(['al-2']));
    await checkRoutineStep(RID, 2, 'BUTTON');
    expect(inserts()).toHaveLength(0);
  });
});
