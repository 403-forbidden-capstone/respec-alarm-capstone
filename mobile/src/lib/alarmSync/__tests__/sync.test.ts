import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AlarmEvent, RingPackage, ScheduleOutcome, ScheduledAlarm } from '@capstone/alarm-core';

import {
  applyCommit,
  cancelAllPhoneAlarms,
  discardPendingEvents,
  failedAlarmCount,
  onEventsUploaded,
  onFailedAlarmsChange,
  reconcile,
  setSigningOut,
  syncNow,
  uploadEvents,
} from '../index';

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
let mockParticipantRows: { alarm_id: string; participant_id: string | null }[] = []; // 지정한 알람의 약속 (participant_id를 고르는 .in 쿼리 — 켜짐 여부와 상관없음)
let mockSelected = '';
const mockAlarmQuery: Record<string, unknown> = {};
for (const method of ['eq', 'gt', 'order']) mockAlarmQuery[method] = jest.fn(() => mockAlarmQuery);
mockAlarmQuery.select = jest.fn((columns: string) => {
  mockSelected = columns;
  return mockAlarmQuery;
});
mockAlarmQuery.limit = jest.fn(async () => ({ data: mockAlarmRows, error: null }));
mockAlarmQuery.in = jest.fn(async () => ({
  data: mockSelected.includes('participant_id') ? mockParticipantRows : mockEnabledIds.map((alarm_id) => ({ alarm_id })),
  error: null,
}));
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
  mockParticipantRows = [];
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

  it('전체 맞추기도 서버에서 꺼졌거나 지워진 미룸 중 예약은 지움 — 서버에 켜진 행이 없다고 확인되면 (안 지우면 꺼진 알람이 미룸으로 다시 울림)', async () => {
    mockCore.list.mockResolvedValue([snoozed('wake-1'), snoozed('wake-2')]);
    mockEnabledIds = ['wake-2']; // wake-1은 다른 기기에서 꺼짐 · 지워짐
    const summary = await reconcile({ nowMs: NOW });
    expect(summary.canceled).toEqual(['wake-1']);
    expect(mockCore.cancel).toHaveBeenCalledTimes(1);
    expect(mockAlarmQuery.in).toHaveBeenCalledWith('alarm_id', ['wake-1', 'wake-2']); // 시각 조건 없이 켜진 행만 물음
  });

  it('전체 맞추기는 서버에 켜진 행이 남은 미룸 중 예약은 지우지 않음 (울린 뒤 서버 행의 시각이 과거가 되어 목록에서 빠지는 정상 경우)', async () => {
    mockCore.list.mockResolvedValue([snoozed('wake-1')]);
    mockEnabledIds = ['wake-1'];
    const summary = await reconcile({ nowMs: NOW });
    expect(summary.canceled).toEqual([]);
    expect(mockCore.cancel).not.toHaveBeenCalled();
  });

  it('전체 맞추기에서 서버 확인이 실패하면 첫 울림이 지난 예약은 지우지 않고(조심 쪽), 나머지 맞추기는 그대로 하며 던지지 않음', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); // 개발 중 로그
    mockAlarmRows = [row('server-1', '2026-10-19T22:30:00.000Z')];
    mockCore.list.mockResolvedValue([snoozed('wake-1')]);
    (mockAlarmQuery.in as jest.Mock<() => Promise<unknown>>).mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    const summary = await reconcile({ nowMs: NOW });
    expect(summary.canceled).toEqual([]);
    expect(summary.scheduled).toEqual(['server-1']);
    // 지정한 알람(alarmIds, 방금 끈 것)은 확인이 실패하면 던져 호출한 쪽이 알게 함
    (mockAlarmQuery.in as jest.Mock<() => Promise<unknown>>).mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    await expect(reconcile({ nowMs: NOW, alarmIds: ['wake-1'] })).rejects.toMatchObject({ message: 'offline' });
    warn.mockRestore();
  });

  it('전체 맞추기에서 첫 울림이 지난 예약이 없으면 서버에 켜진 행을 따로 묻지 않음', async () => {
    mockCore.list.mockResolvedValue([{ id: 'future', type: 'WAKE', intensity: 'NORMAL', title: '회의', atMillis: NOW + 60 * 60_000, snoozeCount: 0, nextRingAt: NOW + 60 * 60_000 }]);
    await reconcile({ nowMs: NOW });
    expect(mockAlarmQuery.in).not.toHaveBeenCalled();
  });

  it('서버 목록이 상한(500)에서 잘렸으면 "서버에 없음"으로 보고 폰 예약을 지우지 않음 — 먼 알람이 지워지지 않게', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row(`s-${i}`, new Date(Date.parse('2026-10-19T22:30:00.000Z') + i * 60_000).toISOString()));
    mockAlarmRows = full;
    const far = Date.parse('2026-12-01T00:00:00.000Z');
    mockCore.list.mockResolvedValue([{ id: 'beyond-limit', type: 'WAKE', intensity: 'NORMAL', title: '먼 알람', atMillis: far, snoozeCount: 0, nextRingAt: far }]);
    const summary = await reconcile({ nowMs: NOW });
    expect(summary.canceled).toEqual([]);
    expect(mockCore.cancel).not.toHaveBeenCalled();

    // 상한보다 적게 왔으면(잘리지 않음) 서버에 없는 폰 예약을 지움
    mockAlarmRows = full.slice(0, 499);
    expect((await reconcile({ nowMs: NOW })).canceled).toEqual(['beyond-limit']);
  });

  it('상한에서 잘려도 서버에 켜진 행이 없다고 확인된 알람(alarmIds로 끈 것)은 지움', async () => {
    mockAlarmRows = Array.from({ length: 500 }, (_, i) => row(`s-${i}`, new Date(Date.parse('2026-10-19T22:30:00.000Z') + i * 60_000).toISOString()));
    mockCore.list.mockResolvedValue([{ id: 'turned-off', type: 'WAKE', intensity: 'NORMAL', title: '끈 알람', atMillis: NOW + 60 * 60_000, snoozeCount: 0, nextRingAt: NOW + 60 * 60_000 }]);
    mockEnabledIds = [];
    expect((await reconcile({ nowMs: NOW, alarmIds: ['turned-off'] })).canceled).toEqual(['turned-off']);
  });

  it('시간대를 안 넘긴 호출(alarmIds로 켜기 · 끄기 반영)도 마지막으로 받은 프로필 시간대로 부제를 만듦', async () => {
    mockAlarmRows = [row('server-1', '2026-10-19T22:30:00.000Z')];
    await reconcile({ nowMs: NOW, timeZone: 'UTC' }); // 로그인 직후 useAlarmSync
    expect(mockCore.scheduleAll.mock.calls.at(-1)?.[0][0].subtitle).toBe('오전 1:00 · 세종대학교');
    await reconcile({ nowMs: NOW, alarmIds: ['server-1'] }); // 시간대 없이
    expect(mockCore.scheduleAll.mock.calls.at(-1)?.[0][0].subtitle).toBe('오전 1:00 · 세종대학교');
    // 로그아웃하면 잊음 (다음 계정의 시간대와 섞이지 않게) -> 기본 서울
    setSigningOut(true);
    setSigningOut(false);
    await reconcile({ nowMs: NOW, alarmIds: ['server-1'] });
    expect(mockCore.scheduleAll.mock.calls.at(-1)?.[0][0].subtitle).toBe('오전 10:00 · 세종대학교');
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

// 준비 알림 글자 · 기상 음성 문장은 같은 약속의 출발 알람에서 나오는데 폰 list()는 글자를 안 돌려줌 — 출발 알람이 바뀌면 준비 · 기상도 다시 걸어야 함
describe('reconcile — 출발 알람이 바뀌면 같은 약속의 준비 · 기상도 다시 걸림', () => {
  const NOW_DAY_BEFORE = Date.parse('2025-05-21T12:00:00.000Z');
  const lesson = { title: '전공 수업', appointment_at: '2025-05-22T01:00:00.000Z', dest_name: '광개토관' }; // 한국 시각 10:00
  const TIMES = { wake: '2025-05-21T23:00:00.000Z', prep: '2025-05-21T23:30:00.000Z', dep: '2025-05-22T00:00:00.000Z', arr: '2025-05-22T00:50:00.000Z' }; // 8:00 · 8:30 · 9:00 · 9:50
  const typeOf = { wake: 'WAKE', prep: 'PREPARE', dep: 'DEPARTURE', arr: 'ARRIVE' } as const;
  type Kind = keyof typeof TIMES;
  const serverRow = (kind: Kind, scheduledAt = TIMES[kind], participant = 'p1') => ({
    alarm_id: kind,
    alarm_type: typeOf[kind],
    scheduled_at: scheduledAt,
    intensity: 'NORMAL',
    sound_key: null,
    snooze_limit: 3,
    is_enabled: true,
    participant_id: participant,
    routine_id: null,
    appointment_participants: { est_travel_minutes: 50, appointments: lesson },
    routines: null,
  });
  const onPhoneAt = (kind: Kind, scheduledAt = TIMES[kind]): ScheduledAlarm => {
    const atMillis = Date.parse(scheduledAt);
    return { id: kind, type: typeOf[kind], intensity: 'NORMAL', title: '전공 수업', atMillis, snoozeCount: 0, nextRingAt: atMillis };
  };
  const allKinds: Kind[] = ['wake', 'prep', 'dep', 'arr'];
  const scheduledIds = () => mockCore.scheduleAll.mock.calls.flatMap(([packages]) => packages.map((p) => p.alarmId));

  it('아무것도 안 바뀌면 다시 걸지 않고 약속도 따로 묻지 않음', async () => {
    mockAlarmRows = allKinds.map((kind) => serverRow(kind));
    mockCore.list.mockResolvedValue(allKinds.map((kind) => onPhoneAt(kind)));
    const summary = await reconcile({ nowMs: NOW_DAY_BEFORE });
    expect(summary).toMatchObject({ scheduled: [], canceled: [], failed: [] });
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
    expect(mockCore.cancel).not.toHaveBeenCalled();
    expect(mockAlarmQuery.in).not.toHaveBeenCalled();
  });

  it('다른 기기에서 출발만 옮기면 준비 · 기상도 새 글자로 다시 걸고, 알람 코어에는 앱 안 묶음 키(groupKey)를 안 넘김', async () => {
    const movedDep = '2025-05-21T23:50:00.000Z'; // 8:50
    mockAlarmRows = [serverRow('wake'), serverRow('prep'), serverRow('dep', movedDep), serverRow('arr')];
    mockCore.list.mockResolvedValue(allKinds.map((kind) => onPhoneAt(kind))); // 폰에는 옛 출발 9:00
    await reconcile({ nowMs: NOW_DAY_BEFORE });
    expect(scheduledIds()).toEqual(['wake', 'prep', 'dep']);
    const packages = mockCore.scheduleAll.mock.calls[0][0];
    expect(packages.find((p) => p.alarmId === 'prep')?.notice).toBe('오전 8:50 출발까지 20분');
    for (const p of packages) expect(Object.keys(p)).not.toContain('groupKey');
  });

  it('출발 알람을 지정해(alarmIds) 켜면 지정하지 않은 같은 약속의 준비 · 기상도 다시 걺 — 켜기 직후 호출 경로', async () => {
    mockAlarmRows = allKinds.map((kind) => serverRow(kind));
    mockCore.list.mockResolvedValue(['wake', 'prep', 'arr'].map((kind) => onPhoneAt(kind as Kind))); // 출발만 폰에 없음
    await reconcile({ nowMs: NOW_DAY_BEFORE, alarmIds: ['dep'] });
    expect(scheduledIds()).toEqual(['wake', 'prep', 'dep']); // 도착은 지정도 약속 묶음도 아니라 그대로
  });

  it('다른 기기에서 출발만 끄면(전체 맞추기) 출발은 지우고 준비 · 기상은 다시 걸어 기본 줄로 돌아감', async () => {
    mockAlarmRows = [serverRow('wake'), serverRow('prep'), serverRow('arr')]; // 서버에는 켜진 출발 행이 없음
    mockCore.list.mockResolvedValue(allKinds.map((kind) => onPhoneAt(kind)));
    mockParticipantRows = [{ alarm_id: 'dep', participant_id: 'p1' }]; // 꺼진 행도 약속은 알려 줌
    const summary = await reconcile({ nowMs: NOW_DAY_BEFORE });
    expect(summary.canceled).toEqual(['dep']);
    expect(scheduledIds()).toEqual(['wake', 'prep']);
    const packages = mockCore.scheduleAll.mock.calls[0][0];
    expect(packages.find((p) => p.alarmId === 'prep')?.notice).toBeUndefined(); // 출발이 없으니 "출발까지 N분" 글자가 빠짐
    // 지울 출발 알람의 약속을 DB에서 읽음 — 약속 열(participant_id)만 보고 켜짐은 거르지 않음
    expect(mockAlarmQuery.select).toHaveBeenCalledWith('alarm_id, participant_id');
    expect(mockAlarmQuery.in).toHaveBeenCalledWith('alarm_id', ['dep']);
  });

  it('출발만 끈 직후 그 출발 알람만 지정해도(alarmIds) 같은 약속의 준비 · 기상이 다시 걸림', async () => {
    mockAlarmRows = [serverRow('wake'), serverRow('prep'), serverRow('arr')];
    mockCore.list.mockResolvedValue(allKinds.map((kind) => onPhoneAt(kind)));
    mockParticipantRows = [{ alarm_id: 'dep', participant_id: 'p1' }];
    mockEnabledIds = []; // 방금 꺼서 서버에 켜진 행이 없음
    const summary = await reconcile({ nowMs: NOW_DAY_BEFORE, alarmIds: ['dep', 'arr'] });
    expect(summary.canceled).toEqual(['dep']);
    expect(scheduledIds()).toEqual(['wake', 'prep']);
  });

  it('지우는 출발 알람이 지난 알람이면(약속 알람이 이미 울림) 약속을 묻지 않고 준비 · 기상도 안 걺', async () => {
    const afterDeparture = Date.parse('2025-05-22T00:10:00.000Z'); // 9:10
    mockAlarmRows = [serverRow('arr')];
    mockCore.list.mockResolvedValue([onPhoneAt('dep'), onPhoneAt('arr')]);
    await reconcile({ nowMs: afterDeparture });
    expect(mockAlarmQuery.select).not.toHaveBeenCalledWith('alarm_id, participant_id');
    expect(mockCore.scheduleAll).not.toHaveBeenCalled();
  });

  it('서버 목록이 상한에서 잘렸으면 "서버에 없음"을 못 믿어 출발 알람의 약속을 묻지 않고 준비 · 기상도 안 걺', async () => {
    mockAlarmRows = Array.from({ length: 500 }, (_, i) => ({ ...serverRow('arr'), alarm_id: `s-${i}`, participant_id: `q-${i}` }));
    mockCore.list.mockResolvedValue([onPhoneAt('dep')]);
    const summary = await reconcile({ nowMs: NOW_DAY_BEFORE });
    expect(mockAlarmQuery.select).not.toHaveBeenCalledWith('alarm_id, participant_id');
    expect(summary.canceled).toEqual([]);
  });

  it('지울 출발 알람의 약속을 읽는 데 실패하면 던짐 — 폰 예약은 그대로 두고 다음 맞추기에서 다시', async () => {
    mockAlarmRows = [serverRow('wake'), serverRow('prep')];
    mockCore.list.mockResolvedValue(allKinds.map((kind) => onPhoneAt(kind)));
    (mockAlarmQuery.in as jest.Mock<() => Promise<unknown>>).mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    await expect(reconcile({ nowMs: NOW_DAY_BEFORE })).rejects.toMatchObject({ message: 'offline' });
    expect(mockCore.cancel).not.toHaveBeenCalled();
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

describe('폰에 못 건 알람 수 — 홈 빨간 줄', () => {
  const futureRow = (id: string) => ({
    alarm_id: id,
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
  });

  beforeEach(() => {
    setSigningOut(true); // 앞 시험이 남긴 목록을 비움
    setSigningOut(false);
  });

  it('전체 맞추기가 목록을 새로 정하고, 저장 결과(applyCommit)가 성공하면 그 알람만 뺌', async () => {
    const onChange = jest.fn();
    const off = onFailedAlarmsChange(onChange);
    mockAlarmRows = [futureRow('a'), futureRow('b')];
    mockCore.scheduleAll.mockResolvedValue([
      { alarmId: 'a', status: 'failed', error: '정확한 알람 권한이 없어요' },
      { alarmId: 'b', status: 'failed', error: '정확한 알람 권한이 없어요' },
    ]);
    await reconcile({ nowMs: NOW });
    expect(failedAlarmCount()).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 일부 맞추기 · 저장 결과는 나온 알람만 고침 — b는 이번에 걸렸고 a는 그대로
    mockCore.scheduleAll.mockImplementation(scheduledAll);
    await applyCommit({ ring_packages: [pkg('b', NOW + 60_000)] });
    expect(failedAlarmCount()).toBe(1);

    // 전체 맞추기는 이번 결과로 목록을 새로 정함 — a도 이번에 걸리면 비어 있음
    await reconcile({ nowMs: NOW });
    expect(failedAlarmCount()).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(3);

    // 로그아웃하면 비움
    mockCore.scheduleAll.mockResolvedValue([{ alarmId: 'a', status: 'failed', error: 'x' }]);
    await reconcile({ nowMs: NOW });
    expect(failedAlarmCount()).toBe(1);
    setSigningOut(true);
    expect(failedAlarmCount()).toBe(0);
    off();
  });
});
