import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AlarmEvent, RingPackage, ScheduleOutcome, ScheduledAlarm } from '@capstone/alarm-core';

import { applyCommit, cancelAllPhoneAlarms, discardPendingEvents, onEventsUploaded, reconcile, setSigningOut, syncNow, uploadEvents } from '../index';

// 알람 코어(폰) · supabase · 데이터 모드를 가짜로 — 오케스트레이션(어느 순서로 무엇을 부르는지)만 확인. 계산은 reconcile.test.ts · events.test.ts
const mockCore = {
  cancel: jest.fn<(id: string) => Promise<void>>(),
  cancelAll: jest.fn<() => Promise<void>>(),
  scheduleAll: jest.fn<(pkgs: readonly RingPackage[]) => Promise<ScheduleOutcome[]>>(),
  list: jest.fn<() => Promise<ScheduledAlarm[]>>(),
  getPendingEvents: jest.fn<() => Promise<AlarmEvent[]>>(),
  markEventsUploaded: jest.fn<(ids: string[]) => Promise<void>>(),
};
jest.mock('@capstone/alarm-core', () => ({
  cancel: (id: string) => mockCore.cancel(id),
  cancelAll: () => mockCore.cancelAll(),
  scheduleAll: (pkgs: readonly RingPackage[]) => mockCore.scheduleAll(pkgs),
  list: () => mockCore.list(),
  getPendingEvents: () => mockCore.getPendingEvents(),
  markEventsUploaded: (ids: string[]) => mockCore.markEventsUploaded(ids),
}));

let mockMock = false;
jest.mock('../../mode', () => ({ isMock: () => mockMock }));

type DbError = { code: string; message: string } | null;
let mockUser: string | null = 'user-1';
const mockUpsert = jest.fn<(rows: { client_event_id: string }[], options: unknown) => Promise<{ error: DbError }>>();
let mockAlarmRows: unknown[] = [];
let mockEnabledIds: string[] = []; // 지정한 알람 중 서버에 켜진 행이 있는 것 (.in으로 끝나는 쿼리)
const mockAlarmQuery: Record<string, unknown> = {};
for (const method of ['select', 'eq', 'gt', 'order']) mockAlarmQuery[method] = jest.fn(() => mockAlarmQuery);
mockAlarmQuery.limit = jest.fn(async () => ({ data: mockAlarmRows, error: null }));
mockAlarmQuery.in = jest.fn(async () => ({ data: mockEnabledIds.map((alarm_id) => ({ alarm_id })), error: null }));
jest.mock('../../supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: mockUser ? { user: { id: mockUser } } : null } }) },
    from: (table: string) => (table === 'alarms' ? mockAlarmQuery : { upsert: (rows: { client_event_id: string }[], options: unknown) => mockUpsert(rows, options) }),
  },
}));

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const pkg = (alarmId: string, atMillis: number): RingPackage => ({ alarmId, type: 'WAKE', atMillis, title: '회의', intensity: 'NORMAL', snoozeLimit: 3 });
const scheduledAll = async (pkgs: readonly RingPackage[]): Promise<ScheduleOutcome[]> => pkgs.map((p) => ({ alarmId: p.alarmId, status: 'scheduled' as const }));
const event = (id: string, alarmId = 'alarm-1'): AlarmEvent => ({ clientEventId: id, alarmId, alarmType: 'WAKE', eventType: 'DISMISSED', at: NOW, sequenceNo: 1, inputSource: 'BUTTON' });

beforeEach(() => {
  jest.clearAllMocks();
  mockMock = false;
  mockUser = 'user-1';
  mockAlarmRows = [];
  mockEnabledIds = [];
  setSigningOut(false);
  mockCore.cancel.mockResolvedValue();
  mockCore.cancelAll.mockResolvedValue();
  mockCore.scheduleAll.mockImplementation(scheduledAll);
  mockCore.list.mockResolvedValue([]);
  mockCore.getPendingEvents.mockResolvedValue([]);
  mockCore.markEventsUploaded.mockResolvedValue();
  mockUpsert.mockResolvedValue({ error: null });
});

describe('applyCommit — 저장 결과를 폰에 반영', () => {
  it('지울 알람은 cancel, 꾸러미는 scheduleAll', async () => {
    const summary = await applyCommit({ canceled_alarm_ids: ['old-1', 'old-2'], ring_packages: [pkg('new-1', NOW + 60_000)] });
    expect(mockCore.cancel.mock.calls.map(([id]) => id)).toEqual(['old-1', 'old-2']);
    expect(mockCore.scheduleAll).toHaveBeenCalledWith([pkg('new-1', NOW + 60_000)]);
    expect(summary).toMatchObject({ canceled: ['old-1', 'old-2'], scheduled: ['new-1'], failed: [] });
  });

  it('deferred · skipped_past · failed를 나눠 돌려주고 던지지 않음', async () => {
    mockCore.cancel.mockRejectedValueOnce(new Error('취소 실패'));
    mockCore.scheduleAll.mockResolvedValue([
      { alarmId: 'a', status: 'deferred' },
      { alarmId: 'b', status: 'skipped_past' },
      { alarmId: 'c', status: 'failed', error: '정확한 알람 권한이 없어요' },
      { alarmId: 'd', status: 'scheduled' },
    ]);
    const summary = await applyCommit({ canceled_alarm_ids: ['x'], ring_packages: [pkg('a', 1), pkg('b', 2), pkg('c', 3), pkg('d', 4)] });
    expect(summary).toEqual({
      scheduled: ['d'],
      skippedPast: ['b'],
      deferred: ['a'],
      canceled: [],
      failed: [
        { alarmId: 'x', error: '취소 실패' },
        { alarmId: 'c', error: '정확한 알람 권한이 없어요' },
      ],
    });
  });

  it('칸이 없어도 됨 (일정 없는 알람을 끈 응답 등)', async () => {
    await applyCommit({});
    expect(mockCore.cancel).not.toHaveBeenCalled();
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
  });
});

describe('reconcile — 서버 ↔ 폰 맞추기', () => {
  const row = (id: string, scheduledAt: string) => ({
    alarm_id: id,
    alarm_type: 'WAKE',
    scheduled_at: scheduledAt,
    intensity: 'NORMAL',
    sound_key: null,
    snooze_limit: 3,
    is_enabled: true,
    participant_id: 'p1',
    routine_id: null,
    appointment_participants: { appointments: { title: '회의', appointment_at: '2026-10-20T01:00:00.000Z', dest_name: '세종대학교' } },
    routines: null,
  });

  it('서버 알람을 읽어 폰에 없는 것은 걸고 서버에 없는 것은 지움', async () => {
    mockAlarmRows = [row('server-1', '2026-10-19T22:30:00.000Z'), row('both', '2026-10-19T23:00:00.000Z')];
    mockCore.list.mockResolvedValue([
      { id: 'both', type: 'WAKE', intensity: 'NORMAL', title: '회의', atMillis: Date.parse('2026-10-19T23:00:00.000Z'), snoozeCount: 0, nextRingAt: Date.parse('2026-10-19T23:00:00.000Z') },
      { id: 'phone-only', type: 'WAKE', intensity: 'NORMAL', title: '옛 알람', atMillis: Date.parse('2026-10-20T05:00:00.000Z'), snoozeCount: 0, nextRingAt: Date.parse('2026-10-20T05:00:00.000Z') },
    ]);
    const summary = await reconcile({ nowMs: NOW });
    expect(summary).toMatchObject({ scheduled: ['server-1'], canceled: ['phone-only'], failed: [] });
    const scheduled = mockCore.scheduleAll.mock.calls[0][0];
    expect(scheduled).toEqual([expect.objectContaining({ alarmId: 'server-1', title: '회의', subtitle: '오전 10:00 · 세종대학교' })]);
  });

  it('alarmIds를 주면 그 알람만 맞춤 — 켜기 · 끄기를 DB에 직접 쓴 뒤', async () => {
    mockAlarmRows = [row('server-1', '2026-10-19T22:30:00.000Z'), row('server-2', '2026-10-19T23:00:00.000Z')];
    mockCore.list.mockResolvedValue([
      { id: 'phone-only-1', type: 'WAKE', intensity: 'NORMAL', title: '옛 알람', atMillis: Date.parse('2026-10-20T05:00:00.000Z'), snoozeCount: 0, nextRingAt: Date.parse('2026-10-20T05:00:00.000Z') },
      { id: 'phone-only-2', type: 'WAKE', intensity: 'NORMAL', title: '옛 알람', atMillis: Date.parse('2026-10-20T06:00:00.000Z'), snoozeCount: 0, nextRingAt: Date.parse('2026-10-20T06:00:00.000Z') },
    ]);
    const summary = await reconcile({ nowMs: NOW, alarmIds: ['server-1', 'phone-only-1'] });
    expect(summary).toMatchObject({ scheduled: ['server-1'], canceled: ['phone-only-1'] });
    expect(mockCore.cancel).toHaveBeenCalledTimes(1);
    expect(mockCore.scheduleAll.mock.calls[0][0].map((p) => p.alarmId)).toEqual(['server-1']);
  });

  // 첫 울림이 지나 미룸 · 다시 울림 대기 중인 폰 예약 (서버 목록은 "지금 이후"만 읽어서 여기에 안 나옴)
  const snoozed = (id: string) => ({ id, type: 'WAKE' as const, intensity: 'NORMAL' as const, title: '회의', atMillis: NOW - 5 * 60_000, snoozeCount: 1, nextRingAt: NOW + 5 * 60_000 });

  it('alarmIds로 끈 알람이 미룸 중이어도(서버에서 꺼짐) 폰 예약을 지움 — 안 지우면 10분 뒤 다시 울림', async () => {
    mockCore.list.mockResolvedValue([snoozed('wake-1')]);
    mockEnabledIds = []; // 방금 H02에서 꺼서 서버에 켜진 행이 없음
    const summary = await reconcile({ nowMs: NOW, alarmIds: ['wake-1'] });
    expect(summary.canceled).toEqual(['wake-1']);
    expect(mockCore.cancel).toHaveBeenCalledWith('wake-1');
    expect(mockAlarmQuery.in).toHaveBeenCalledWith('alarm_id', ['wake-1']); // 시각 조건 없이 켜진 행이 있는지만 물음
  });

  it('alarmIds로 맞출 때 서버에 켜진 채 남아 있는(첫 시각이 지난) 알람은 지우지 않음 — 미룸 중에 강도만 바꾼 경우', async () => {
    mockCore.list.mockResolvedValue([snoozed('wake-1')]);
    mockEnabledIds = ['wake-1'];
    const summary = await reconcile({ nowMs: NOW, alarmIds: ['wake-1'] });
    expect(summary.canceled).toEqual([]);
    expect(mockCore.cancel).not.toHaveBeenCalled();
  });

  it('전체 맞추기는 서버 목록에 없는 미룸 중 예약을 지우지 않음 (울린 뒤 서버 행이 과거가 되는 정상 경우)', async () => {
    mockCore.list.mockResolvedValue([snoozed('wake-1')]);
    const summary = await reconcile({ nowMs: NOW });
    expect(summary.canceled).toEqual([]);
    expect(mockAlarmQuery.in).not.toHaveBeenCalled();
  });

  it('쿼리는 내 켜진 알람 · 지금 이후', async () => {
    await reconcile({ nowMs: NOW });
    expect(mockAlarmQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockAlarmQuery.eq).toHaveBeenCalledWith('is_enabled', true);
    expect(mockAlarmQuery.gt).toHaveBeenCalledWith('scheduled_at', new Date(NOW).toISOString());
  });

  it('가짜 모드 · 로그인 전에는 아무것도 안 함', async () => {
    mockMock = true;
    expect(await reconcile({ nowMs: NOW })).toMatchObject({ scheduled: [], canceled: [] });
    mockMock = false;
    mockUser = null;
    expect(await reconcile({ nowMs: NOW })).toMatchObject({ scheduled: [], canceled: [] });
    expect(mockCore.list).not.toHaveBeenCalled();
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
  });
});

describe('uploadEvents — 울림 기록 올리기', () => {
  it('기록을 alarm_events에 upsert(번호가 같으면 무시)하고 올린 것만 폰에서 지움', async () => {
    mockCore.getPendingEvents.mockResolvedValue([event('e1'), event('e2')]);
    const result = await uploadEvents();
    expect(result).toEqual({ uploaded: 2, dropped: 0, kept: 0 });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [rows, options] = mockUpsert.mock.calls[0];
    expect(rows.map((r) => r.client_event_id)).toEqual(['e1', 'e2']);
    expect(options).toEqual({ onConflict: 'client_event_id', ignoreDuplicates: true });
    expect(mockCore.markEventsUploaded).toHaveBeenCalledWith(['e1', 'e2']);
  });

  it('올릴 것이 없거나 가짜 모드 · 로그인 전이면 아무것도 안 함', async () => {
    expect(await uploadEvents()).toEqual({ uploaded: 0, dropped: 0, kept: 0 });
    mockCore.getPendingEvents.mockResolvedValue([event('e1')]);
    mockMock = true;
    await uploadEvents();
    mockMock = false;
    mockUser = null;
    await uploadEvents();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCore.markEventsUploaded).not.toHaveBeenCalled();
  });

  it('네트워크 같은 일시 오류면 폰에 그대로 두고 하나씩 올려 보지도 않음', async () => {
    mockCore.getPendingEvents.mockResolvedValue([event('e1'), event('e2')]);
    mockUpsert.mockResolvedValue({ error: { code: '', message: 'Network request failed' } });
    expect(await uploadEvents()).toEqual({ uploaded: 0, dropped: 0, kept: 2 });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockCore.markEventsUploaded).not.toHaveBeenCalled();
  });

  it('한 줄이 막혀(지워진 알람) 전체가 실패하면 하나씩 올려 나머지는 살리고 막힌 것은 버림', async () => {
    mockCore.getPendingEvents.mockResolvedValue([event('ok-1'), event('bad', 'deleted-alarm'), event('ok-2')]);
    mockUpsert.mockImplementation(async (rows) =>
      rows.some((r) => r.client_event_id === 'bad') ? { error: { code: '42501', message: 'new row violates row-level security policy' } } : { error: null },
    );
    expect(await uploadEvents()).toEqual({ uploaded: 2, dropped: 1, kept: 0 });
    expect(mockUpsert).toHaveBeenCalledTimes(4); // 한꺼번에 1 + 하나씩 3
    expect(mockCore.markEventsUploaded).toHaveBeenCalledWith(['bad', 'ok-1', 'ok-2']);
  });

  it('뒤처리 훅에는 서버에 올라간 기록만 넘기고, 훅이 던지면 올린 기록을 폰에 남겨 다음에 다시', async () => {
    const handler = jest.fn<(events: AlarmEvent[]) => Promise<void>>().mockRejectedValueOnce(new Error('departed_at 저장 실패')).mockResolvedValue();
    const off = onEventsUploaded(handler);
    mockCore.getPendingEvents.mockResolvedValue([event('e1')]);
    expect(await uploadEvents()).toEqual({ uploaded: 1, dropped: 0, kept: 1 });
    expect(handler).toHaveBeenCalledWith([expect.objectContaining({ clientEventId: 'e1' })]);
    expect(mockCore.markEventsUploaded).toHaveBeenCalledWith([]); // 지우지 않음

    expect(await uploadEvents()).toEqual({ uploaded: 1, dropped: 0, kept: 0 }); // 다음에 다시 — 훅이 이번엔 성공
    expect(mockCore.markEventsUploaded).toHaveBeenLastCalledWith(['e1']);
    off();
    await uploadEvents();
    expect(handler).toHaveBeenCalledTimes(2); // 등록을 풀면 더 안 불림
  });

  it('맞추기 · 올리기가 겹쳐 불려도 한 줄로 차례대로', async () => {
    const order: string[] = [];
    mockCore.getPendingEvents.mockImplementation(async () => {
      order.push('upload:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('upload:end');
      return [];
    });
    mockCore.list.mockImplementation(async () => {
      order.push('reconcile:list');
      return [];
    });
    await Promise.all([uploadEvents(), reconcile({ nowMs: NOW })]);
    expect(order).toEqual(['upload:start', 'upload:end', 'reconcile:list']);
  });
});

describe('discardPendingEvents — 로그아웃 정리', () => {
  it('남은 기록을 전부 폰에서 지움', async () => {
    mockCore.getPendingEvents.mockResolvedValue([event('e1'), event('e2')]);
    expect(await discardPendingEvents()).toBe(2);
    expect(mockCore.markEventsUploaded).toHaveBeenCalledWith(['e1', 'e2']);
  });
});

describe('로그아웃 정리 — 폰 알람 전부 지우기와 맞추기의 경합', () => {
  const futureRow = {
    alarm_id: 'server-1',
    alarm_type: 'WAKE',
    scheduled_at: '2026-10-19T22:30:00.000Z',
    intensity: 'NORMAL',
    sound_key: null,
    snooze_limit: 3,
    is_enabled: true,
    participant_id: 'p1',
    routine_id: null,
    appointment_participants: { appointments: { title: '회의', appointment_at: '2026-10-20T01:00:00.000Z', dest_name: null } },
    routines: null,
  };

  it('cancelAllPhoneAlarms는 맞추기 · 올리기와 같은 줄 — 앞에 서 있는 맞추기가 끝난 뒤에 지움', async () => {
    const order: string[] = [];
    mockAlarmRows = [futureRow];
    mockCore.list.mockImplementation(async () => {
      order.push('reconcile:list');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    mockCore.scheduleAll.mockImplementation(async (pkgs) => {
      order.push('reconcile:schedule');
      return scheduledAll(pkgs);
    });
    mockCore.cancelAll.mockImplementation(async () => void order.push('cancelAll'));
    await Promise.all([reconcile({ nowMs: NOW }), cancelAllPhoneAlarms()]);
    expect(order).toEqual(['reconcile:list', 'reconcile:schedule', 'cancelAll']); // 거꾸로면 맞추기가 지운 뒤에 다시 걺
  });

  it('cancelAllPhoneAlarms가 실패하면 던지고, 그 뒤 줄은 계속 돎', async () => {
    mockCore.cancelAll.mockRejectedValueOnce(new Error('native error'));
    await expect(cancelAllPhoneAlarms()).rejects.toThrow('native error');
    mockCore.cancelAll.mockResolvedValue();
    await expect(cancelAllPhoneAlarms()).resolves.toBeUndefined();
  });

  it('로그아웃 중에는 맞추기가 서버를 읽지도 폰을 건드리지도 않음 (앱이 앞에 올 때 syncNow가 끼어든 경우)', async () => {
    mockAlarmRows = [futureRow];
    setSigningOut(true);
    const [, summary] = await Promise.all([cancelAllPhoneAlarms(), syncNow({ nowMs: NOW }).then(() => reconcile({ nowMs: NOW }))]);
    expect(summary).toEqual({ scheduled: [], skippedPast: [], deferred: [], canceled: [], failed: [] });
    expect(mockCore.list).not.toHaveBeenCalled();
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
  });

  it('읽는 사이에 로그아웃이 시작돼도 폰에 걸지 않음', async () => {
    mockAlarmRows = [futureRow];
    mockCore.list.mockImplementation(async () => {
      setSigningOut(true);
      return [];
    });
    expect(await reconcile({ nowMs: NOW })).toMatchObject({ scheduled: [], canceled: [] });
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
  });

  it('표시를 끄면(다시 로그인) 맞추기가 다시 돎', async () => {
    mockAlarmRows = [futureRow];
    setSigningOut(true);
    await reconcile({ nowMs: NOW });
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
    setSigningOut(false);
    expect(await reconcile({ nowMs: NOW })).toMatchObject({ scheduled: ['server-1'] });
  });
});
