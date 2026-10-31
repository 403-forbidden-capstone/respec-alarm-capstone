import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { geoEventId } from '@/features/alarm/participantTimes';
import { filterArgs, type FakeCall, type FakeResult } from '@/features/alarm/testkit/fakeSupabase';
import { db, kst } from '@/mocks/data';

import { listDetections, listEarlierDepartures, rejectDetection, undoReject } from '../api';
import { REJECTED_VALUE, SETTLE_AFTER_MINUTES } from '../detections';

// 실데이터는 가짜 Supabase로 쿼리 모양 · 쓰는 순서만 확인 (진짜 RLS는 실제 Supabase에서), 가짜 모드는 목업 기록에서 만든 감지
let mockRoutes: Record<string, (call: FakeCall) => FakeResult | undefined> = {};
const mockCalls: FakeCall[] = [];
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('@/features/alarm/testkit/fakeSupabase')>('@/features/alarm/testkit/fakeSupabase');
  return {
    supabase: {
      from: (table: string) =>
        build(table, (call) => {
          mockCalls.push(call);
          return mockRoutes[`${call.table}:${call.op}`]?.(call);
        }),
    },
  };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
let mockIsMock = false;
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));
let mockNow = new Date('2025-05-22T09:05:00+09:00');
jest.mock('@/lib/clock', () => ({ now: () => mockNow }));

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const only = (table: string, op: FakeCall['op']) => mockCalls.filter((c) => c.table === table && c.op === op);
const writes = () => mockCalls.filter((c) => c.op !== 'select');

type Source = 'BUTTON' | 'MANUAL' | 'LOCATION' | null;
const ALARMS = [
  { alarm_id: 'al-wake', alarm_type: 'WAKE', scheduled_at: iso('08:00') },
  { alarm_id: 'al-dep', alarm_type: 'DEPARTURE', scheduled_at: iso('08:50') },
  { alarm_id: 'al-arr', alarm_type: 'ARRIVE', scheduled_at: iso('09:50') },
];
const participantRow = (patch: { departed_at?: string | null; departed_source?: Source; arrived_at?: string | null; arrived_source?: Source; alarms?: typeof ALARMS } = {}) => ({
  participant_id: 'p-1',
  appointment_id: 'ap-1',
  departed_at: patch.departed_at ?? null,
  departed_source: patch.departed_at ? (patch.departed_source === undefined ? 'LOCATION' : patch.departed_source) : null,
  arrived_at: patch.arrived_at ?? null,
  arrived_source: patch.arrived_at ? (patch.arrived_source === undefined ? 'LOCATION' : patch.arrived_source) : null,
  actual_travel_minutes: null,
  origin_lat: null,
  origin_lng: null,
  est_travel_minutes: 50,
  buffer_minutes: 10,
  appointments: { appointment_at: iso('10:00'), dest_lat: null, dest_lng: null },
  alarms: patch.alarms ?? ALARMS,
});

// 기본: 참여 조건 하나 · 그날 예정 기상 8:00 · 준비 실측 50분(8:50 출발로 셈한 값) · 지우기가 한 줄을 바꿈
function setup(opts: { participant?: ReturnType<typeof participantRow>; prepare?: number | null; cleared?: boolean } = {}) {
  mockRoutes = {
    'appointment_participants:select': () => ({ data: opts.participant ?? participantRow({ departed_at: iso('08:50') }) }),
    'appointment_participants:update': () => ({ data: opts.cleared === false ? [] : [{ participant_id: 'p-1' }] }),
    'daily_records:select': () => ({ data: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: opts.prepare === undefined ? 50 : opts.prepare } }),
    'alarms:select': () => ({ data: [{ scheduled_at: iso('08:00') }] }),
  };
}

beforeEach(() => {
  mockCalls.length = 0;
  mockRoutes = {};
  mockIsMock = false;
  mockNow = new Date('2025-05-22T09:05:00+09:00');
});

describe('listDetections — 그날 위치로 잡은 출발 · 도착', () => {
  it('출처 칸이 LOCATION인 것만, 그날(한국 0시 ~ 다음 날 0시) 내 것만 읽고 시각순으로', async () => {
    mockRoutes['appointment_participants:select'] = (call) =>
      call.columns?.includes('departed_at')
        ? { data: [{ participant_id: 'p-2', departed_at: iso('13:10') }, { participant_id: 'p-1', departed_at: iso('08:50') }] }
        : { data: [{ participant_id: 'p-1', arrived_at: iso('09:58'), is_late: false }] };
    const list = await listDetections(new Date(at('15:00')));
    expect(list.map((d) => [d.participantId, d.kind, d.at.toISOString(), d.source, d.isLate])).toEqual([
      ['p-1', 'DEPART', iso('08:50'), 'LOCATION', null],
      ['p-1', 'ARRIVE', iso('09:58'), 'LOCATION', false],
      ['p-2', 'DEPART', iso('13:10'), 'LOCATION', null],
    ]);
    const [departed, arrived] = only('appointment_participants', 'select');
    expect(filterArgs(departed, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(departed, 'eq', 'departed_source')).toEqual(['LOCATION']);
    expect(filterArgs(departed, 'gte', 'departed_at')).toEqual([new Date(at('00:00')).toISOString()]);
    expect(filterArgs(departed, 'lt', 'departed_at')).toEqual([new Date(at('00:00') + 24 * 3_600_000).toISOString()]);
    expect(filterArgs(arrived, 'eq', 'arrived_source')).toEqual(['LOCATION']);
    expect(filterArgs(arrived, 'gte', 'arrived_at')).toEqual([new Date(at('00:00')).toISOString()]);
  });

  it('settled — 감지 뒤 20분이 지나야 친구 화면 · 일기에 반영 (D61), 정확히 20분이면 반영', async () => {
    expect(SETTLE_AFTER_MINUTES).toBe(20);
    mockNow = new Date(at('09:10'));
    mockRoutes['appointment_participants:select'] = (call) =>
      call.columns?.includes('departed_at') ? { data: [{ participant_id: 'p-1', departed_at: iso('08:50') }] } : { data: [{ participant_id: 'p-1', arrived_at: iso('09:58'), is_late: true }] };
    const list = await listDetections(new Date(at('09:10')));
    expect(list.map((d) => [d.kind, d.settled, d.isLate])).toEqual([
      ['DEPART', true, null],
      ['ARRIVE', false, true],
    ]);
  });

  it('도착은 늘 지각 / 아님 — 판정이 비어 있으면(약속 시각을 못 읽음) 지각 아님으로 (사용자에게 유리한 쪽), 출발은 null', async () => {
    mockRoutes['appointment_participants:select'] = (call) =>
      call.columns?.includes('departed_at') ? { data: [] } : { data: [{ participant_id: 'p-1', arrived_at: iso('10:20'), is_late: null }] };
    expect((await listDetections(new Date(at('15:00')))).map((d) => d.isLate)).toEqual([false]);
  });

  it('읽기 오류는 던짐', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(listDetections(new Date(at('09:00')))).rejects.toMatchObject({ message: 'offline' });
  });
});

describe("listEarlierDepartures — '확인할 기록' (7.13.7 출발이 여러 번 잡힘)", () => {
  // 위치 기록 한 줄 — 출발 알람(그 참여 조건의 지금 출발 · 출처)
  const event = (hhmm: string, current: { departed_at: string | null; departed_source: Source }, over: { alarm_type?: string; participant_id?: string | null } = {}) => ({
    event_at: iso(hhmm),
    alarms: { alarm_type: over.alarm_type ?? 'DEPARTURE', participant_id: over.participant_id === undefined ? 'p-1' : over.participant_id, appointment_participants: current },
  });
  const nowLocation = { departed_at: iso('08:40'), departed_source: 'LOCATION' as const };

  it('지금 출발보다 앞선 위치 출발 줄만, 시각순 — 그날 내 위치 출발 기록(ACKNOWLEDGED · LOCATION)만 읽음', async () => {
    mockRoutes['alarm_events:select'] = () => ({
      data: [event('08:40', nowLocation), event('08:10', nowLocation), event('07:30', nowLocation), event('08:00', nowLocation, { alarm_type: 'PREPARE' })],
    });
    expect(await listEarlierDepartures(new Date(at('22:00')))).toEqual([
      { participantId: 'p-1', at: new Date(at('07:30')) },
      { participantId: 'p-1', at: new Date(at('08:10')) },
    ]);
    const [read] = only('alarm_events', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(read, 'eq', 'event_type')).toEqual(['ACKNOWLEDGED']);
    expect(filterArgs(read, 'eq', 'input_source')).toEqual(['LOCATION']);
    expect(filterArgs(read, 'gte', 'event_at')).toEqual([new Date(at('00:00')).toISOString()]);
    expect(filterArgs(read, 'lt', 'event_at')).toEqual([new Date(at('00:00') + 24 * 3_600_000).toISOString()]);
  });

  it('지금 출발이 응답(원탭 · 직접 입력 · 옛 앱 원탭)이면 이미 답한 것이라 뺌, 지금 출발이 비었으면([아니에요]) 남은 줄 모두', async () => {
    mockRoutes['alarm_events:select'] = () => ({
      data: [
        event('08:10', { departed_at: iso('08:40'), departed_source: 'BUTTON' }),
        event('08:15', { departed_at: iso('08:40'), departed_source: null }, { participant_id: 'p-2' }),
        event('12:10', { departed_at: null, departed_source: null }, { participant_id: 'p-3' }),
        event('12:20', { departed_at: null, departed_source: null }, { participant_id: null }), // 참여 조건 없는 알람
      ],
    });
    expect(await listEarlierDepartures(new Date(at('22:00')))).toEqual([{ participantId: 'p-3', at: new Date(at('12:10')) }]);
  });

  it('읽기 오류는 던짐', async () => {
    mockRoutes['alarm_events:select'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(listEarlierDepartures(new Date(at('22:00')))).rejects.toMatchObject({ message: 'offline' });
  });
});

describe('rejectDetection — [아니에요] 1탭 정정 (D61)', () => {
  it('위치 출발: 고친 값 기록 한 줄 → 준비 실측 되돌림 → 기록 화면 위치 줄 지움 → 시각 · 출처 · 이동시간 비움 (이 순서)', async () => {
    setup();
    const snapshot = await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' });
    expect(snapshot).toEqual({ participantId: 'p-1', kind: 'DEPART', at: new Date(at('08:50')), editId: expect.any(String) });

    const [log] = only('user_edit_logs', 'insert');
    expect(log.payload).toEqual({
      edit_id: snapshot!.editId,
      user_id: 'user-1',
      appointment_id: 'ap-1',
      alarm_id: 'al-dep',
      screen: 'H01',
      field: 'departed_at',
      alarm_type: 'DEPARTURE',
      auto_value: iso('08:50'),
      edited_value: { rejected: true },
    });
    expect(REJECTED_VALUE).not.toBeNull(); // NULL은 "자동으로 되돌림"이라 다른 값

    const [prepare] = only('daily_records', 'update');
    expect(prepare.payload).toEqual({ actual_prepare_minutes: null });
    expect(filterArgs(prepare, 'eq', 'actual_prepare_minutes')).toEqual([50]); // 8:50 출발 − 예정 기상 8:00으로 셈한 값일 때만
    expect(filterArgs(prepare, 'eq', 'record_date')).toEqual(['2025-05-22']);

    const [removed] = only('alarm_events', 'delete');
    expect(filterArgs(removed, 'eq', 'client_event_id')).toEqual([geoEventId('p-1', 'DEPART', at('08:50'))]);
    expect(filterArgs(removed, 'eq', 'user_id')).toEqual(['user-1']);

    const [clear] = only('appointment_participants', 'update');
    expect(clear.payload).toEqual({ departed_at: null, departed_source: null, actual_travel_minutes: null });
    expect(filterArgs(clear, 'eq', 'departed_at')).toEqual([iso('08:50')]);
    expect(filterArgs(clear, 'eq', 'departed_source')).toEqual(['LOCATION']);
    expect(filterArgs(clear, 'eq', 'user_id')).toEqual(['user-1']);

    expect(writes().map((c) => `${c.table}:${c.op}`)).toEqual(['user_edit_logs:insert', 'daily_records:update', 'alarm_events:delete', 'appointment_participants:update']);
  });

  it('위치 도착: 지각 판정도 비움, 알림(NTF)에서 누르면 화면 값 NTF, 준비 실측은 안 건드림', async () => {
    setup({ participant: participantRow({ departed_at: iso('08:50'), departed_source: 'BUTTON', arrived_at: iso('10:03') }) });
    const snapshot = await rejectDetection({ participantId: 'p-1', kind: 'ARRIVE', screen: 'NTF' });
    expect(snapshot).toMatchObject({ kind: 'ARRIVE', at: new Date(at('10:03')) });
    expect(only('user_edit_logs', 'insert')[0].payload).toMatchObject({ screen: 'NTF', field: 'arrived_at', alarm_type: 'ARRIVE', alarm_id: 'al-arr', auto_value: iso('10:03') });
    expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: null, arrived_source: null, is_late: null, late_minutes: null, actual_travel_minutes: null });
    expect(filterArgs(only('alarm_events', 'delete')[0], 'eq', 'client_event_id')).toEqual([geoEventId('p-1', 'ARRIVE', at('10:03'))]);
    expect(mockCalls.filter((c) => c.table === 'daily_records')).toEqual([]);
  });

  it('지금 값이 위치가 아니면 아무것도 안 함 — 원탭 · 직접 입력 · 옛 앱 원탭(출처 비어 있음) · 빈 칸 · 지워진 참여 조건', async () => {
    for (const participant of [
      participantRow({ departed_at: iso('08:50'), departed_source: 'BUTTON' }),
      participantRow({ departed_at: iso('08:50'), departed_source: 'MANUAL' }),
      participantRow({ departed_at: iso('08:50'), departed_source: null }),
      participantRow(),
    ]) {
      setup({ participant });
      expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).toBeNull();
    }
    mockRoutes['appointment_participants:select'] = () => ({ data: null });
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('at을 주면 지금 위치 값의 시각과 같을 때만 지움 — 다르면(더 새 판정으로 바뀜) 아무것도 안 쓰고 null, 없으면 예전 동작', async () => {
    setup();
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'NTF', at: at('08:40') })).toBeNull(); // 오래된 알림
    expect(writes()).toEqual([]);

    setup();
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'NTF', at: at('08:50') })).toMatchObject({ at: new Date(at('08:50')) });
    expect(only('appointment_participants', 'update')).toHaveLength(1);

    setup();
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'NTF' })).not.toBeNull(); // at 없음
  });

  it('준비 실측이 다른 출발로 셈한 값이면(같은 날 다른 약속) 그대로', async () => {
    setup({ prepare: 35 });
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).not.toBeNull();
    expect(only('daily_records', 'update')).toEqual([]);
  });

  // 지우기 직전까지는 위치 값, 지우기가 0줄로 끝난 뒤 다시 읽으면 then 값
  const changedBeforeClear = (then: ReturnType<typeof participantRow>) => {
    setup({ cleared: false });
    let reads = 0;
    mockRoutes['appointment_participants:select'] = () => ({ data: reads++ === 0 ? participantRow({ departed_at: iso('08:50') }) : then });
  };

  it('그 사이 원탭이 덮어 못 지웠으면(바뀐 줄 0) 남긴 고친 값 기록도 지우고 null', async () => {
    changedBeforeClear(participantRow({ departed_at: iso('08:53'), departed_source: 'BUTTON' }));
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).toBeNull();
    const [logged] = only('user_edit_logs', 'insert');
    const [dropped] = only('user_edit_logs', 'delete');
    expect(filterArgs(dropped, 'eq', 'edit_id')).toEqual([(logged.payload as { edit_id: string }).edit_id]);
  });

  it('동시에 두 번 눌러 다른 호출이 먼저 지웠으면(값이 비었음) null — 고친 값 기록은 그 호출 몫이라 둠 (이 호출이 줄을 만들었어도)', async () => {
    changedBeforeClear(participantRow());
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).toBeNull();
    expect(only('user_edit_logs', 'insert')).toHaveLength(1);
    expect(only('user_edit_logs', 'delete')).toEqual([]);

    // 다른 호출이 줄을 먼저 만들었어도(23505) 같음
    changedBeforeClear(participantRow());
    mockRoutes['user_edit_logs:insert'] = () => ({ error: { code: '23505', message: 'duplicate key' } });
    expect(await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).toBeNull();
    expect(only('user_edit_logs', 'delete')).toEqual([]);
  });

  it('앞 시도가 기록만 남기고 끊겼으면(같은 번호 23505) 이어서 지움 — 기록은 한 줄', async () => {
    setup();
    mockRoutes['user_edit_logs:insert'] = () => ({ error: { code: '23505', message: 'duplicate key' } });
    const first = await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' });
    expect(first).not.toBeNull();
    expect(only('appointment_participants', 'update')).toHaveLength(1);

    setup();
    const again = await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'NTF' });
    expect(again?.editId).toBe(first?.editId); // 같은 판정이면 같은 번호
  });

  it('그 종류의 알람 행이 없으면 고친 값 기록의 alarm_id는 비움', async () => {
    setup({ participant: participantRow({ departed_at: iso('08:50'), alarms: [] }) });
    await rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' });
    expect(only('user_edit_logs', 'insert')[0].payload).toMatchObject({ alarm_id: null, appointment_id: 'ap-1' });
  });

  it('쓰기 오류는 던짐 — 시각은 남아 다시 누를 수 있음', async () => {
    setup();
    mockRoutes['alarm_events:delete'] = () => ({ error: { code: '', message: 'timeout' } });
    await expect(rejectDetection({ participantId: 'p-1', kind: 'DEPART', screen: 'H01' })).rejects.toMatchObject({ message: 'timeout' });
    expect(only('appointment_participants', 'update')).toEqual([]);
  });
});

describe('undoReject — 5초 되돌리기 (L6 안건후보: 감지 안내 정정 · 채널 기본안)', () => {
  const snapshot = { participantId: 'p-1', kind: 'DEPART' as const, at: new Date(at('08:50')), editId: 'edit-1' };

  it('빈 칸이면 위치 출처로 다시 씀 (위치 기록 · 준비 실측도 같은 규칙으로) + 고친 값 기록 지움', async () => {
    setup({ participant: participantRow(), prepare: null });
    expect(await undoReject(snapshot)).toBe(true);
    const [write] = only('appointment_participants', 'update');
    expect(write.payload).toEqual({ departed_at: iso('08:50'), departed_source: 'LOCATION' });
    expect(filterArgs(write, 'is', 'departed_at')).toEqual([null]);
    expect((only('alarm_events', 'upsert')[0].payload as { client_event_id: string }[])[0].client_event_id).toBe(geoEventId('p-1', 'DEPART', at('08:50')));
    expect(only('daily_records', 'update')[0].payload).toEqual({ actual_prepare_minutes: 50 });
    const [dropped] = only('user_edit_logs', 'delete');
    expect(filterArgs(dropped, 'eq', 'edit_id')).toEqual(['edit-1']);
    expect(filterArgs(dropped, 'eq', 'user_id')).toEqual(['user-1']);
  });

  it('그 사이 원탭이 들어왔으면 덮지 않고 false — 고친 값 기록은 지움', async () => {
    setup({ participant: participantRow({ departed_at: iso('08:53'), departed_source: 'BUTTON' }) });
    expect(await undoReject(snapshot)).toBe(false);
    expect(only('appointment_participants', 'update')).toEqual([]);
    expect(only('alarm_events', 'upsert')).toEqual([]);
    expect(only('user_edit_logs', 'delete')).toHaveLength(1);
  });

  it('도착을 되돌리면 지각 판정도 바로 다시 (위치 도착 +3분은 지각 아님 — 보류 없음)', async () => {
    setup({ participant: participantRow() });
    expect(await undoReject({ ...snapshot, kind: 'ARRIVE', at: new Date(at('10:03')) })).toBe(true);
    expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: iso('10:03'), arrived_source: 'LOCATION', is_late: false, late_minutes: 0 });
  });

  it('그 사이 더 이른 위치 출발이 들어왔으면 되돌린 출발(더 늦음)로 바꿈 — 위치 출발끼리는 늦은 쪽 (participantTimes)', async () => {
    setup({ participant: participantRow({ departed_at: iso('08:40') }), prepare: null });
    expect(await undoReject(snapshot)).toBe(true);
    expect(only('appointment_participants', 'update')[0].payload).toMatchObject({ departed_at: iso('08:50'), departed_source: 'LOCATION' });
  });
});

describe('가짜 데이터 모드 — 위치 감지는 안 돎, 화면 초안용 목업 감지', () => {
  beforeEach(() => {
    mockIsMock = true;
    mockNow = kst(22, 475); // 목업 아침 7:55
  });

  it('지난 평일 기록의 "자동 · 지오펜스" 출발 · 도착을 감지로 — Supabase를 부르지 않음', async () => {
    const list = await listDetections(kst(21, 0));
    expect(list).toEqual([
      { participantId: 'mock-21', kind: 'DEPART', at: kst(21, 482), source: 'LOCATION', settled: true, isLate: null },
      { participantId: 'mock-21', kind: 'ARRIVE', at: kst(21, 532), source: 'LOCATION', settled: true, isLate: false },
    ]);
    expect((await listDetections(kst(13, 0))).find((d) => d.kind === 'ARRIVE')?.isLate).toBe(true); // 5월 13일은 3분 지각
    expect(await listDetections(kst(22, 0))).toEqual([]); // 오늘 · 주말은 없음
    expect(await listDetections(kst(17, 0))).toEqual([]);
    expect(mockCalls).toEqual([]);
  });

  it('[아니에요] → 목록에서 빠지고 고친 값 기록(H01)이 쌓임, 되돌리면 돌아옴', async () => {
    const before = db.editLogs.length;
    const snapshot = await rejectDetection({ participantId: 'mock-20', kind: 'DEPART', screen: 'H01' });
    expect(snapshot).toMatchObject({ participantId: 'mock-20', kind: 'DEPART', at: kst(20, 482) });
    expect((await listDetections(kst(20, 0))).map((d) => d.kind)).toEqual(['ARRIVE']);
    expect(db.editLogs.slice(before)).toEqual([expect.objectContaining({ screen: 'H01', field: 'departed_at', autoValue: kst(20, 482), editedValue: REJECTED_VALUE })]);
    expect(await rejectDetection({ participantId: 'mock-20', kind: 'DEPART', screen: 'H01' })).toBeNull(); // 이미 지움

    expect(await undoReject(snapshot!)).toBe(true);
    expect((await listDetections(kst(20, 0))).map((d) => d.kind)).toEqual(['DEPART', 'ARRIVE']);
    expect(db.editLogs.length).toBe(before);
    expect(mockCalls).toEqual([]);
  });

  it('at을 주면 목업도 같은 규칙 — 다르면 지우지 않음, 같으면 지움', async () => {
    expect(await rejectDetection({ participantId: 'mock-20', kind: 'DEPART', screen: 'NTF', at: kst(20, 400).getTime() })).toBeNull();
    expect((await listDetections(kst(20, 0))).map((d) => d.kind)).toEqual(['DEPART', 'ARRIVE']);
    const snapshot = await rejectDetection({ participantId: 'mock-20', kind: 'DEPART', screen: 'NTF', at: kst(20, 482).getTime() });
    expect(snapshot).toMatchObject({ at: kst(20, 482) });
    await undoReject(snapshot!);
  });

  it('없는 감지는 null', async () => {
    expect(await rejectDetection({ participantId: 'a1', kind: 'DEPART', screen: 'H01' })).toBeNull();
  });

  it("확인할 기록 — 지각한 5월 13일에만 앞 출발 하나(오전 7:45), 그 밖의 날은 없음 · Supabase를 부르지 않음", async () => {
    expect(await listEarlierDepartures(kst(13, 0))).toEqual([{ participantId: 'mock-13', at: kst(13, 465) }]);
    const [departed] = (await listDetections(kst(13, 0))).filter((d) => d.kind === 'DEPART');
    expect(departed.at.getTime()).toBeGreaterThan(kst(13, 465).getTime()); // 지금 출발(8:08)보다 앞
    expect(await listEarlierDepartures(kst(21, 0))).toEqual([]);
    expect(await listEarlierDepartures(kst(22, 0))).toEqual([]);
    expect(mockCalls).toEqual([]);
  });
});
