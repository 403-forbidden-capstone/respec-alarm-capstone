import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { calls, filterOf, onCall, resetFake, type FakeCall, type FakeReply } from '@/features/records/testing/fakeSupabase';
import { UserError } from '@/lib/errors';
import { dayKey } from '@/lib/format';

import {
  advanceRoutine,
  declineRoutineSuggestion,
  editJournal,
  getEveningRoutine,
  getJournal,
  getRoutine,
  getTodayRoutine,
  listTodos,
  saveRoutine,
  toggleTodo,
} from '../real';
import type { Routine } from '../types';

// real.ts가 어느 테이블을 어떤 조건으로 읽고 어떤 순서로 쓰는지 — 가짜 클라이언트로 확인 (칸 이름은 tsc, 행 ↔ 화면 변환은 map.test.ts)
jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('@/features/records/testing/fakeSupabase')>('@/features/records/testing/fakeSupabase').fakeClient }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
// 한국 시간 2026-10-19(월) 오전 9:30
jest.mock('@/lib/clock', () => ({ now: () => new Date('2026-10-19T00:30:00Z') }));
const mockReconcile = jest.fn<(options: { alarmIds?: string[] }) => Promise<unknown>>();
jest.mock('@/lib/alarmSync', () => ({ reconcile: (options: { alarmIds?: string[] }) => mockReconcile(options) }));

const ROUTINE_ID = '3f2b8c1e-7d4a-4b6c-9e10-5a1b2c3d4e5f';
const NEW_ROUTINE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const reply = (handler: (call: FakeCall) => FakeReply | undefined) => onCall(handler);
const onlyCalls = (table: string, op?: FakeCall['op']) => calls.filter((c) => c.table === table && (!op || c.op === op));

beforeEach(() => {
  resetFake();
  mockReconcile.mockReset();
  mockReconcile.mockResolvedValue({});
});

// 평일 아침 루틴: 7:00 물 마시기(알람) · 7:02 스트레칭 · 7:07 샤워(알람) · 7:22 출발
const morningRow = (patch: Record<string, unknown> = {}) => ({
  routine_id: ROUTINE_ID,
  title: '출근 준비',
  goal: null,
  repeat_days: 'MON~FRI',
  steps: [
    { order: 1, title: '물 마시기', offset: 420, minutes: 2, is_alarm: true },
    { order: 2, title: '스트레칭', offset: 422, minutes: 5, is_alarm: false },
    { order: 3, title: '샤워', offset: 427, minutes: 15, is_alarm: true },
    { order: 4, title: '출발', offset: 442, minutes: 5, is_alarm: false },
  ],
  is_active: true,
  daily_journals: null,
  ...patch,
});

describe('준비물', () => {
  it('그날 준비물(ITEM) — 내 것, due_date가 그날, 만든 순서', async () => {
    reply(() => ({
      data: [
        { todo_id: 't-1', title: '노트북', is_done: true },
        { todo_id: 't-2', title: '회의 자료', is_done: false },
      ],
    }));
    const todos = await listTodos(new Date('2026-10-20T03:00:00Z'));
    expect(todos).toEqual([
      { id: 't-1', title: '노트북', done: true },
      { id: 't-2', title: '회의 자료', done: false },
    ]);
    const q = calls[0];
    expect([q.table, filterOf(q, 'eq', 'user_id')?.[1], filterOf(q, 'eq', 'todo_type')?.[1], filterOf(q, 'eq', 'due_date')?.[1]]).toEqual(['todos', 'user-1', 'ITEM', '2026-10-20']);
  });

  it('체크하면 is_done과 done_at, 다시 누르면 지움', async () => {
    reply((c) => (c.op === 'select' ? { data: { is_done: false } } : undefined));
    await toggleTodo('t-1');
    expect(onlyCalls('todos', 'update')[0].payload).toEqual({ is_done: true, done_at: '2026-10-19T00:30:00.000Z' });
    expect([filterOf(onlyCalls('todos', 'update')[0], 'eq', 'todo_id')?.[1], filterOf(onlyCalls('todos', 'update')[0], 'eq', 'user_id')?.[1]]).toEqual(['t-1', 'user-1']);

    resetFake();
    reply((c) => (c.op === 'select' ? { data: { is_done: true } } : undefined));
    await toggleTodo('t-1');
    expect(onlyCalls('todos', 'update')[0].payload).toEqual({ is_done: false, done_at: null });
  });

  it('없는 항목은 아무것도 쓰지 않고 넘어감, 읽기 · 쓰기 실패는 던짐', async () => {
    reply(() => ({ data: null }));
    await toggleTodo('nope');
    expect(onlyCalls('todos', 'update')).toHaveLength(0);
    reply(() => ({ error: { message: 'boom' } }));
    await expect(toggleTodo('t-1')).rejects.toMatchObject({ message: 'boom' });
    await expect(listTodos(new Date())).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('H01 오늘 루틴', () => {
  const state = (ackedAlarmIds: string[], routines: unknown[] = [morningRow()]) =>
    reply((c) => {
      if (c.table === 'routines') return { data: routines };
      if (c.table === 'alarms') return { data: [{ alarm_id: 'a-1', step_order: 1 }, { alarm_id: 'a-3', step_order: 3 }] };
      if (c.table === 'alarm_events' && c.op === 'select') return { data: ackedAlarmIds.map((alarm_id) => ({ alarm_id })) };
      return undefined;
    });

  it('켜져 있고 오늘(월요일) 요일이 든 루틴 — 끝낸 단계는 오늘 단계 알람의 확인', async () => {
    state(['a-1']);
    const progress = await getTodayRoutine();
    expect(progress).toEqual({ id: ROUTINE_ID, title: '출근 준비', steps: ['물 마시기', '스트레칭', '샤워', '출발'], done: 1 });
    const routines = onlyCalls('routines')[0];
    expect([filterOf(routines, 'eq', 'user_id')?.[1], filterOf(routines, 'eq', 'is_active')?.[1]]).toEqual(['user-1', true]);
    const events = onlyCalls('alarm_events')[0];
    expect([filterOf(events, 'eq', 'event_type')?.[1], filterOf(events, 'in', 'alarm_id')?.[1], filterOf(events, 'gte', 'event_at')?.[1], filterOf(events, 'lt', 'event_at')?.[1]]).toEqual([
      'ACKNOWLEDGED',
      ['a-1', 'a-3'],
      '2026-10-18T15:00:00.000Z',
      '2026-10-19T15:00:00.000Z',
    ]);
  });

  it('단계 알람이 없는 루틴은 확인을 읽지 않고 0단계', async () => {
    reply((c) => (c.table === 'routines' ? { data: [morningRow()] } : { data: [] }));
    expect((await getTodayRoutine())?.done).toBe(0);
    expect(onlyCalls('alarm_events')).toHaveLength(0);
  });

  it('오늘 요일이 아니거나 저녁 루틴이면 null', async () => {
    state([], [morningRow({ repeat_days: 'TUE~FRI' })]);
    expect(await getTodayRoutine()).toBeNull();
    state([], [morningRow({ steps: [{ order: 1, title: '자기 전', offset: 1290, minutes: 5, is_alarm: true }] })]);
    expect(await getTodayRoutine()).toBeNull();
    state([], []);
    expect(await getTodayRoutine()).toBeNull();
  });
});

describe('H01 루틴 단계 완료', () => {
  const state = (ackedAlarmIds: string[]) =>
    reply((c) => {
      if (c.table === 'routines') return { data: morningRow() };
      if (c.table === 'alarms') return { data: [{ alarm_id: 'a-1', step_order: 1 }, { alarm_id: 'a-3', step_order: 3 }] };
      if (c.table === 'alarm_events' && c.op === 'select') return { data: ackedAlarmIds.map((alarm_id) => ({ alarm_id })) };
      return undefined;
    });

  it('다음 알람 있는 단계를 확인으로 기록 — 폰의 원탭과 같은 ACKNOWLEDGED, 출처는 직접 입력', async () => {
    state([]);
    const progress = await advanceRoutine(ROUTINE_ID);
    expect(progress?.done).toBe(1);
    expect(onlyCalls('alarm_events', 'insert')[0].payload).toEqual({
      alarm_id: 'a-1',
      user_id: 'user-1',
      event_type: 'ACKNOWLEDGED',
      event_at: '2026-10-19T00:30:00.000Z',
      input_source: 'MANUAL',
    });
  });

  it('알람 없는 단계는 건너뛰어 다음 알람 단계로 (스트레칭 → 샤워)', async () => {
    state(['a-1']);
    const progress = await advanceRoutine(ROUTINE_ID);
    expect(onlyCalls('alarm_events', 'insert')[0].payload).toMatchObject({ alarm_id: 'a-3' });
    expect(progress?.done).toBe(3);
  });

  it('남은 단계에 알람이 없으면 이유와 함께 거절 (기록할 곳이 없음)', async () => {
    state(['a-1', 'a-3']);
    const err = await advanceRoutine(ROUTINE_ID).catch((e: unknown) => e);
    // 샤워(3)까지 끝냈고 출발(4)에는 알람이 없음
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('남은 단계에 알람이 없어서 끝낸 것으로 기록할 수 없어요');
    expect(onlyCalls('alarm_events', 'insert')).toHaveLength(0);
  });

  it('다 끝낸 뒤 한 번 더 누르면 오늘 확인을 지우고 처음부터', async () => {
    reply((c) => {
      if (c.table === 'routines') return { data: morningRow({ steps: [{ order: 1, title: '물 마시기', offset: 420, minutes: 2, is_alarm: true }] }) };
      if (c.table === 'alarms') return { data: [{ alarm_id: 'a-1', step_order: 1 }] };
      if (c.table === 'alarm_events' && c.op === 'select') return { data: [{ alarm_id: 'a-1' }] };
      return undefined;
    });
    const progress = await advanceRoutine(ROUTINE_ID);
    expect(progress?.done).toBe(0);
    const del = onlyCalls('alarm_events', 'delete')[0];
    expect([filterOf(del, 'eq', 'user_id')?.[1], filterOf(del, 'eq', 'event_type')?.[1], filterOf(del, 'in', 'alarm_id')?.[1], filterOf(del, 'gte', 'event_at')?.[1]]).toEqual([
      'user-1',
      'ACKNOWLEDGED',
      ['a-1'],
      '2026-10-18T15:00:00.000Z',
    ]);
  });

  it('없는 루틴 · 가짜 주소는 읽지 않고 null', async () => {
    expect(await advanceRoutine('r1')).toBeNull();
    expect(calls).toHaveLength(0);
    reply(() => ({ data: null }));
    expect(await advanceRoutine(ROUTINE_ID)).toBeNull();
  });
});

describe('H01 저녁 루틴 · A04 읽기', () => {
  it('가장 최근에 저장한 루틴 (updated_at 순), 단계를 못 읽는 루틴은 건너뜀', async () => {
    reply(() => ({ data: [morningRow({ routine_id: 'broken', steps: [] }), morningRow({ title: '회의 전날 준비' })] }));
    expect(await getEveningRoutine()).toEqual({ id: ROUTINE_ID, title: '회의 전날 준비', days: ['월', '화', '수', '목', '금'], startMinute: 420, stepCount: 4 });
    const q = calls[0];
    expect([filterOf(q, 'eq', 'user_id')?.[1], filterOf(q, 'order', 'updated_at')?.[1]]).toEqual(['user-1', { ascending: false }]);
    reply(() => ({ data: [] }));
    expect(await getEveningRoutine()).toBeNull();
  });

  it('저장한 루틴 열기: 내 루틴만, 없거나 가짜 주소(r1)는 읽지 않고 null', async () => {
    reply(() => ({ data: morningRow({ daily_journals: { record_date: '2026-10-14' } }) }));
    const r = await getRoutine(ROUTINE_ID);
    expect([r?.id, r?.sourceJournal, r?.steps.length]).toEqual([ROUTINE_ID, '2026-10-14', 4]);
    expect([filterOf(calls[0], 'eq', 'routine_id')?.[1], filterOf(calls[0], 'eq', 'user_id')?.[1]]).toEqual([ROUTINE_ID, 'user-1']);

    resetFake();
    expect(await getRoutine('r1')).toBeNull();
    expect(calls).toHaveLength(0);
    reply(() => ({ data: null }));
    expect(await getRoutine(ROUTINE_ID)).toBeNull();
  });

  it('새 루틴: 제안한 일기의 글 첫 줄이 이름인 빈 초안 (일기가 없어도 열림)', async () => {
    reply(() => ({ data: { routine_suggestion: '회의 전날 준비\n수요일 밤 9:30부터' } }));
    const draft = await getRoutine('new', '2026-10-14');
    expect([draft?.id, draft?.title, draft?.sourceJournal, draft?.days, draft?.steps.length]).toEqual([null, '회의 전날 준비', '2026-10-14', [], 1]);
    expect([calls[0].table, filterOf(calls[0], 'eq', 'record_date')?.[1]]).toEqual(['daily_journals', '2026-10-14']);

    resetFake();
    reply(() => ({ data: null }));
    expect((await getRoutine('new', '2026-10-15'))?.title).toBe('새 루틴');
    resetFake();
    expect((await getRoutine('new'))?.sourceJournal).toBeNull();
    expect((await getRoutine('new', '어제'))?.sourceJournal).toBeNull(); // 날짜가 아닌 값도 일기 없이 연 것으로
    expect(calls).toHaveLength(0); // 일기 없이 열면 읽지 않음
  });
});

describe('A04 루틴 저장', () => {
  const draft = (patch: Partial<Routine> = {}): Routine => ({
    id: null,
    title: '회의 전날 준비',
    goal: '여유로운 아침',
    days: ['수'],
    startMinute: 21 * 60 + 30,
    steps: [
      { id: 's1', name: '회의 자료 확인', minutes: 5, alarm: true },
      { id: 's2', name: '노트북 충전', minutes: 2, alarm: false },
      { id: 's3', name: '  ', minutes: 3, alarm: true },
    ],
    active: true,
    sourceJournal: '2026-10-14',
    ...patch,
  });
  const saveDb = (existingAlarms: { alarm_id: string; step_order: number }[] = [], extra?: (c: FakeCall) => FakeReply | undefined) =>
    reply((c) => {
      const custom = extra?.(c);
      if (custom) return custom;
      if (c.table === 'daily_journals' && c.op === 'select') return { data: { journal_id: 'j-1' } };
      if (c.table === 'routines' && c.op === 'insert') return { data: { routine_id: NEW_ROUTINE_ID } };
      if (c.table === 'routines' && c.op === 'update') return { data: [{ routine_id: ROUTINE_ID }] };
      if (c.table === 'alarms' && c.op === 'select') return { data: existingAlarms };
      if (c.table === 'alarms' && c.op === 'insert') return { data: (c.payload as unknown[]).map((_, i) => ({ alarm_id: `new-${i + 1}` })) };
      return undefined;
    });

  it('새 루틴: routines 한 줄 → 단계 알람 → 제안한 일기를 수락으로 → 만든 알람만 폰에 맞춤', async () => {
    const order: string[] = [];
    mockReconcile.mockImplementation(async () => {
      order.push('reconcile');
    });
    saveDb([], (c) => {
      order.push(`${c.table}:${c.op}`);
      return undefined;
    });
    const saved = await saveRoutine(draft());
    expect(order).toEqual(['daily_journals:select', 'routines:insert', 'alarms:select', 'alarms:insert', 'daily_journals:update', 'reconcile']);

    expect(onlyCalls('routines', 'insert')[0].payload).toEqual({
      title: '회의 전날 준비',
      goal: '여유로운 아침',
      repeat_days: 'WED',
      steps: [
        { order: 1, title: '회의 자료 확인', offset: 1290, minutes: 5, is_alarm: true },
        { order: 2, title: '노트북 충전', offset: 1295, minutes: 2, is_alarm: false },
        { order: 3, title: '새 단계', offset: 1297, minutes: 3, is_alarm: true }, // 이름이 빈 단계는 새 단계
      ],
      is_active: true,
      user_id: 'user-1',
      source_journal_id: 'j-1',
      origin: 'AI_SUGGESTED',
    });
    // 수요일(10/21) 밤 9:30 · 9:37 — 한국 시간 → UTC
    expect(onlyCalls('alarms', 'insert')[0].payload).toEqual([
      { user_id: 'user-1', routine_id: NEW_ROUTINE_ID, step_order: 1, alarm_type: 'ROUTINE', scheduled_at: '2026-10-21T12:30:00.000Z', is_enabled: true },
      { user_id: 'user-1', routine_id: NEW_ROUTINE_ID, step_order: 3, alarm_type: 'ROUTINE', scheduled_at: '2026-10-21T12:37:00.000Z', is_enabled: true },
    ]);
    const accept = onlyCalls('daily_journals', 'update')[0];
    expect([accept.payload, filterOf(accept, 'eq', 'journal_id')?.[1]]).toEqual([{ suggestion_status: 'APPLIED' }, 'j-1']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['new-1', 'new-2'] });
    expect(saved).toMatchObject({ id: NEW_ROUTINE_ID, sourceJournal: '2026-10-14' });
    expect(saved.steps[2].name).toBe('새 단계');
  });

  it('일기 제안이 아닌 새 루틴은 직접 만든 루틴(USER), 일기에서 온 표시가 없으면 일기를 읽지 않음', async () => {
    saveDb();
    await saveRoutine(draft({ sourceJournal: null }));
    expect(onlyCalls('routines', 'insert')[0].payload).toMatchObject({ source_journal_id: null, origin: 'USER' });
    expect(onlyCalls('daily_journals')).toHaveLength(0);
  });

  it('이미 있는 루틴 고치기: 시각이 바뀐 알람은 고치고, 없어진 단계 알람은 지우고, 새 단계 알람은 만듦', async () => {
    saveDb([
      { alarm_id: 'old-1', step_order: 1 },
      { alarm_id: 'old-2', step_order: 2 }, // 이제 알람 없는 단계
    ]);
    const saved = await saveRoutine(draft({ id: ROUTINE_ID, sourceJournal: null }));
    expect(saved.id).toBe(ROUTINE_ID);
    expect(onlyCalls('routines', 'insert')).toHaveLength(0);
    const update = onlyCalls('routines', 'update')[0];
    expect([filterOf(update, 'eq', 'routine_id')?.[1], filterOf(update, 'eq', 'user_id')?.[1]]).toEqual([ROUTINE_ID, 'user-1']);
    expect(update.payload).not.toHaveProperty('source_journal_id'); // 어느 일기에서 왔는지는 바꾸지 않음

    expect(filterOf(onlyCalls('alarms', 'delete')[0], 'in', 'alarm_id')?.[1]).toEqual(['old-2']);
    const alarmUpdate = onlyCalls('alarms', 'update')[0];
    expect(alarmUpdate.payload).toMatchObject({ scheduled_at: '2026-10-21T12:30:00.000Z', is_enabled: true });
    expect(filterOf(alarmUpdate, 'eq', 'alarm_id')?.[1]).toBe('old-1');
    expect(onlyCalls('alarms', 'insert')[0].payload).toEqual([expect.objectContaining({ step_order: 3, routine_id: ROUTINE_ID })]);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['old-1', 'old-2', 'new-1'] });
  });

  it('꺼 둔 루틴이면 단계 알람을 모두 지우고 걸지 않음 (지운 알람은 폰에서도 빼도록 맞춤)', async () => {
    saveDb([{ alarm_id: 'old-1', step_order: 1 }]);
    await saveRoutine(draft({ id: ROUTINE_ID, sourceJournal: null, active: false }));
    expect(filterOf(onlyCalls('alarms', 'delete')[0], 'in', 'alarm_id')?.[1]).toEqual(['old-1']);
    expect(onlyCalls('alarms', 'insert')).toHaveLength(0);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['old-1'] });
  });

  it('날짜가 아닌 일기 표시는 일기 없이 저장한 것으로 (DB 날짜 오류를 부르지 않음)', async () => {
    saveDb();
    await saveRoutine(draft({ sourceJournal: '어제' }));
    expect(onlyCalls('daily_journals')).toHaveLength(0);
    expect(onlyCalls('routines', 'insert')[0].payload).toMatchObject({ source_journal_id: null, origin: 'USER' });
  });

  it('고르지 않은 요일이면 알람이 없고, 알람 맞출 것이 없으면 폰도 안 부름', async () => {
    saveDb();
    await saveRoutine(draft({ sourceJournal: null, days: [] }));
    expect(onlyCalls('alarms', 'insert')).toHaveLength(0);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('새 루틴의 알람 저장이 실패하면 방금 만든 루틴을 지우고 던짐 (다시 저장해도 루틴이 둘이 되지 않게)', async () => {
    saveDb([], (c) => (c.table === 'alarms' && c.op === 'insert' ? { error: { message: 'rls' } } : undefined));
    await expect(saveRoutine(draft())).rejects.toMatchObject({ message: 'rls' });
    const cleanup = onlyCalls('routines', 'delete')[0];
    expect([filterOf(cleanup, 'eq', 'routine_id')?.[1], filterOf(cleanup, 'eq', 'user_id')?.[1]]).toEqual([NEW_ROUTINE_ID, 'user-1']);
    expect(onlyCalls('daily_journals', 'update')).toHaveLength(0);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('이미 있던 루틴은 알람 저장이 실패해도 지우지 않음, 없는 루틴이면 이유와 함께 거절', async () => {
    saveDb([], (c) => (c.table === 'alarms' && c.op === 'insert' ? { error: { message: 'rls' } } : undefined));
    await expect(saveRoutine(draft({ id: ROUTINE_ID, sourceJournal: null }))).rejects.toMatchObject({ message: 'rls' });
    expect(onlyCalls('routines', 'delete')).toHaveLength(0);

    resetFake();
    saveDb([], (c) => (c.table === 'routines' && c.op === 'update' ? { data: [] } : undefined));
    await expect(saveRoutine(draft({ id: ROUTINE_ID }))).rejects.toThrow('루틴을 찾을 수 없어요');
  });

  it('폰 맞추기가 실패해도 저장은 성공으로', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcile.mockRejectedValue(new Error('read failed'));
    saveDb();
    await expect(saveRoutine(draft({ sourceJournal: null }))).resolves.toMatchObject({ id: NEW_ROUTINE_ID });
    warn.mockRestore();
  });
});

describe('A03 일기', () => {
  const journalRow = (patch: Record<string, unknown> = {}) => ({
    journal_id: 'j-1',
    record_date: '2026-10-19',
    ai_summary: 'AI가 쓴 글',
    edited_summary: null,
    is_edited: false,
    coaching_insight: '코칭',
    encouragement: '격려',
    routine_suggestion: '회의 전날 준비',
    suggestion_status: 'PENDING',
    ...patch,
  });

  it('일기 + 그날 사실(기록에서) + 이 일기로 만든 가장 최근 루틴', async () => {
    reply((c) => {
      if (c.table === 'daily_journals') return { data: journalRow() };
      if (c.table === 'alarm_events') {
        return {
          data: [
            { event_id: 1, event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:00Z', snooze_minutes: null, input_source: null, alarms: { alarm_type: 'WAKE', appointment_participants: null } },
            { event_id: 2, event_type: 'WAKE_CONFIRMED', event_at: '2026-10-18T22:31:00Z', snooze_minutes: null, input_source: 'USAGE', alarms: { alarm_type: 'WAKE', appointment_participants: null } },
          ],
        };
      }
      if (c.table === 'routines') return { data: { routine_id: ROUTINE_ID } };
      return undefined;
    });
    const j = await getJournal('2026-10-19');
    expect([j?.text, j?.coaching, j?.routineId, j?.suggestion.title]).toEqual(['AI가 쓴 글', '코칭', ROUTINE_ID, '회의 전날 준비']);
    expect(j?.facts.map((f) => `${f.label} · ${f.source}`)).toEqual(['기상 확인 · 자동 판정']); // 울림은 사실에 안 넣음
    const q = onlyCalls('daily_journals')[0];
    expect([filterOf(q, 'eq', 'user_id')?.[1], filterOf(q, 'eq', 'record_date')?.[1]]).toEqual(['user-1', '2026-10-19']);
    const routines = onlyCalls('routines')[0];
    expect([filterOf(routines, 'eq', 'source_journal_id')?.[1], filterOf(routines, 'order', 'created_at')?.[1]]).toEqual(['j-1', { ascending: false }]);
  });

  it('일기가 없는 날 · 날짜가 아닌 주소는 null (기록은 읽지 않음)', async () => {
    reply(() => ({ data: null }));
    expect(await getJournal('2026-10-18')).toBeNull();
    expect(onlyCalls('alarm_events')).toHaveLength(0);
    resetFake();
    expect(await getJournal('어제')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('고치기: 고친 글만 바꾸고 AI 원본은 그대로, AI 글과 같게 되돌리면 고친 글을 지움', async () => {
    reply((c) => (c.op === 'select' ? { data: { journal_id: 'j-1', ai_summary: 'AI가 쓴 글' } } : undefined));
    await editJournal('2026-10-19', '내가 고친 글');
    const update = onlyCalls('daily_journals', 'update')[0];
    expect(update.payload).toEqual({ edited_summary: '내가 고친 글', is_edited: true });
    expect([filterOf(update, 'eq', 'journal_id')?.[1], filterOf(update, 'eq', 'user_id')?.[1]]).toEqual(['j-1', 'user-1']);

    resetFake();
    reply((c) => (c.op === 'select' ? { data: { journal_id: 'j-1', ai_summary: 'AI가 쓴 글' } } : undefined));
    await editJournal('2026-10-19', 'AI가 쓴 글');
    expect(onlyCalls('daily_journals', 'update')[0].payload).toEqual({ edited_summary: null, is_edited: false });
  });

  it('없는 일기를 고치면 이유와 함께 거절', async () => {
    reply(() => ({ data: null }));
    await expect(editJournal('2026-10-19', '글')).rejects.toBeInstanceOf(UserError);
    await expect(editJournal('어제', '글')).rejects.toBeInstanceOf(UserError);
    expect(onlyCalls('daily_journals', 'update')).toHaveLength(0);
  });

  it('루틴 제안 괜찮아요: 기다리는 제안만 거절로 (숨기는 기한은 D24 열림이라 저장 안 함)', async () => {
    reply(() => undefined);
    await declineRoutineSuggestion('2026-10-19');
    const update = onlyCalls('daily_journals', 'update')[0];
    expect(update.payload).toEqual({ suggestion_status: 'REJECTED' });
    expect([filterOf(update, 'eq', 'record_date')?.[1], filterOf(update, 'eq', 'suggestion_status')?.[1], filterOf(update, 'eq', 'user_id')?.[1]]).toEqual(['2026-10-19', 'PENDING', 'user-1']);
    expect(dayKey(new Date('2026-10-18T15:00:00Z'))).toBe('2026-10-19');
  });
});
