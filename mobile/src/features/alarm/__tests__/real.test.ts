import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { formatTime } from '@/lib/format';

import { recallDetail } from '../detailCache';
import { resetAlarmMemory } from '../reset';
import { clearEdits, peekEdits } from '../editQueue';
import { forgetPlaces, lookupPlace, toPoint } from '../places';
import { TravelConfirmNeeded } from '../travelConfirm';
import * as real from '../real';
import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { defaultAlarms, type AlarmSettingsDraft, type AppointmentDraft, type Estimate } from '../types';

// 실데이터 구현(real.ts)의 쿼리 · 쓰기 순서 시험 — 진짜 Supabase는 못 붙여 봤으므로 가짜 쿼리 빌더에 쿼리 모양을 기록해 확인함.
// 행 → 화면 변환은 map.test.ts, 요청 만들기는 request.test.ts, 판정은 wake.test.ts가 맡음
//   지금 시각(lib/clock)은 가짜 시나리오 시각 = 2025년 5월 22일 오전 7:55 (한국)

type Handler = (call: FakeCall) => FakeResult | undefined | Promise<FakeResult | undefined>;
let mockRoutes: Record<string, Handler> = {};
const mockCalls: FakeCall[] = [];
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
  return {
    supabase: {
      from: (table: string) =>
        fakeBuilder(table, (call) => {
          mockCalls.push(call);
          return mockRoutes[`${call.table}:${call.op}`]?.(call);
        }),
    },
  };
});
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));

// 지금 시각 — 기본은 가짜 시나리오 시각, 기상 확인 시험은 해제 시각 기준으로 정함
let mockNow: Date | null = null;
jest.mock('@/lib/clock', () => {
  const actual = jest.requireActual<typeof import('@/lib/clock')>('@/lib/clock');
  return { ...actual, now: () => mockNow ?? actual.now() };
});

const mockCallEdge = jest.fn<(name: string, body?: Record<string, unknown>, options?: unknown) => Promise<unknown>>();
jest.mock('@/lib/edge', () => ({ ...jest.requireActual<object>('@/lib/edge'), callEdge: (name: string, body?: Record<string, unknown>, options?: unknown) => mockCallEdge(name, body, options) }));

const mockApplyCommit = jest.fn<(result: unknown) => Promise<{ failed: unknown[] }>>();
const mockReconcile = jest.fn<(options?: { alarmIds?: string[] }) => Promise<{ failed: unknown[] }>>();
const mockUploadEvents = jest.fn<() => Promise<unknown>>();
const mockSyncNow = jest.fn<(options?: { rollSeriesId?: string }) => Promise<void>>();
jest.mock('@/lib/alarmSync', () => ({
  applyCommit: (r: unknown) => mockApplyCommit(r),
  reconcile: (o?: { alarmIds?: string[] }) => mockReconcile(o),
  uploadEvents: () => mockUploadEvents(),
  syncNow: (o?: { rollSeriesId?: string }) => mockSyncNow(o),
}));

const mockCore = {
  stop: jest.fn<() => Promise<void>>(),
  getRinging: jest.fn<() => Promise<unknown>>(),
  snooze: jest.fn<(minutes: number) => Promise<boolean>>(),
  releaseRingOverLock: jest.fn<(dismissKeyguard: boolean) => Promise<void>>(),
  ackRingScreen: jest.fn<() => void>(),
  cancel: jest.fn<(id: string) => Promise<void>>(),
  list: jest.fn<() => Promise<unknown[]>>(),
  hasUsageAccess: jest.fn<() => Promise<boolean>>(),
  getUsageSpans: jest.fn<(from: number, to: number) => Promise<{ startMillis: number; endMillis: number }[]>>(),
  getPendingEvents: jest.fn<() => Promise<unknown[]>>(),
};
jest.mock('@capstone/alarm-core', () => ({
  stop: () => mockCore.stop(),
  getRinging: () => mockCore.getRinging(),
  snooze: (minutes: number) => mockCore.snooze(minutes),
  releaseRingOverLock: (dismissKeyguard: boolean) => mockCore.releaseRingOverLock(dismissKeyguard),
  ackRingScreen: () => mockCore.ackRingScreen(),
  cancel: (id: string) => mockCore.cancel(id),
  list: () => mockCore.list(),
  hasUsageAccess: () => mockCore.hasUsageAccess(),
  getUsageSpans: (from: number, to: number) => mockCore.getUsageSpans(from, to),
  getPendingEvents: () => mockCore.getPendingEvents(),
  makeUuid: () => 'uuid-fixed',
  toUseSpans: (spans: { startMillis: number; endMillis: number }[], dismissedAt: number) =>
    spans.map((s) => [(s.startMillis - dismissedAt) / 60_000, (s.endMillis - dismissedAt) / 60_000]),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 5월 22일 한국 시각
const kst = (hhmm: string, day = 22) => `2025-05-${String(day).padStart(2, '0')}T${hhmm}:00+09:00`;

const alarmRow = (id: string, type: string, hhmm: string, overrides: Record<string, unknown> = {}) => ({
  alarm_id: id,
  alarm_type: type,
  scheduled_at: kst(hhmm),
  intensity: 'NORMAL',
  voice_tone: 'NEUTRAL',
  sound_key: 'theme_default',
  vibration: null,
  is_enabled: true,
  time_source: 'AUTO',
  intensity_source: 'AUTO',
  ...overrides,
});
const meetingAlarms = () => [alarmRow('00000000-0000-4000-8000-0000000000b1', 'WAKE', '08:00'), alarmRow('00000000-0000-4000-8000-0000000000b2', 'PREPARE', '08:30'), alarmRow('00000000-0000-4000-8000-0000000000b3', 'DEPARTURE', '09:00'), alarmRow('00000000-0000-4000-8000-0000000000b4', 'ARRIVE', '09:50')];

const participantRow = (overrides: Record<string, unknown> = {}, appointment: Record<string, unknown> = {}, alarms: unknown[] = meetingAlarms()) => ({
  participant_id: 'p-1',
  origin_name: '집',
  transport_type: 'TRANSIT',
  est_travel_minutes: 50,
  travel_source: 'API',
  prepare_minutes: 60,
  buffer_minutes: 10,
  appointments: { appointment_id: '00000000-0000-4000-8000-0000000000a1', title: '팀 주간회의', appointment_at: kst('10:00'), dest_name: '세종대학교', importance: 'NORMAL', recurrence_rule: null, groups: { group_name: '캡스톤팀' }, ...appointment },
  alarms,
  ...overrides,
});

const callsTo = (table: string, op?: FakeCall['op']) => mockCalls.filter((c) => c.table === table && (op == null || c.op === op));
const isCount = (c: FakeCall) => (c.options as { head?: boolean } | undefined)?.head === true;

beforeEach(() => {
  mockRoutes = {};
  mockCalls.length = 0;
  mockNow = null;
  jest.clearAllMocks();
  mockCallEdge.mockReset(); // 안 쓴 mockResolvedValueOnce가 다음 시험으로 넘어가지 않게
  mockApplyCommit.mockResolvedValue({ failed: [] });
  mockReconcile.mockResolvedValue({ failed: [] });
  mockUploadEvents.mockResolvedValue({});
  mockSyncNow.mockResolvedValue();
  mockCore.stop.mockResolvedValue();
  mockCore.cancel.mockResolvedValue();
  mockCore.list.mockResolvedValue([]);
  mockCore.hasUsageAccess.mockResolvedValue(true);
  mockCore.getUsageSpans.mockResolvedValue([]);
  mockCore.getPendingEvents.mockResolvedValue([]);
  forgetPlaces();
  clearEdits();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // 저장 뒤처리 실패는 개발 중에만 로그 — 시험 출력에 안 섞이게
});

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

describe('목록 · 하루 일정 · 알람 설정 읽기', () => {
  it('listAppointments: 내 참여 조건 + 일정 없는 알람을 시각 순으로, 알람 없는 일정은 뺌 · 오늘 0시 30일 전부터', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        participantRow({ participant_id: 'p-2' }, { appointment_id: 'appt-2', title: '치과 예약', appointment_at: kst('15:30') }, []),
        participantRow(),
      ],
    });
    mockRoutes['todos:select'] = () => ({ data: [{ appointment_id: '00000000-0000-4000-8000-0000000000a1', title: '노트북' }] });
    mockRoutes['alarms:select'] = () => ({
      data: [{ ...alarmRow('00000000-0000-4000-8000-0000000000c1', 'WAKE', '07:00'), recurrence_rule: null }],
    });
    const list = await real.listAppointments();

    expect(list.map((a) => `${a.title} ${formatTime(a.at)}`)).toEqual(['알람 오전 7:00', '팀 주간회의 오전 10:00']); // 치과 예약은 알람이 없어 H02에 없음
    expect(list[1].items).toEqual(['노트북']);
    expect(list[0].standalone).toBe(true);

    const [read] = callsTo('appointment_participants', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual(['2025-04-21T15:00:00.000Z']); // 5월 22일 0시(한국) − 30일
    expect(filterArgs(read, 'order', 'appointments(appointment_at)')).toEqual([]); // 상한(300)에 걸려도 가까운 날짜부터
    expect(read.filters.some(([method, n]) => method === 'limit' && n === 300)).toBe(true);
    const [standalone] = callsTo('alarms', 'select');
    expect(filterArgs(standalone, 'order', 'scheduled_at')).toEqual([]);
    expect(filterArgs(standalone, 'is', 'participant_id')).toEqual([null]);
    expect(filterArgs(standalone, 'is', 'routine_id')).toEqual([null]);
    expect(filterArgs(standalone, 'eq', 'alarm_type')).toEqual(['WAKE']);
  });

  it('listAppointments: 반복 묶음(series_id)은 지금 이후 가장 가까운 회차 하나 — 지난 회차 · 먼 회차는 안 보이고, 묶음이 하나뿐인 일정 · 일정 없는 알람은 그대로', async () => {
    const A = '00000000-0000-4000-8000-0000000000a1';
    // 지금 = 5월 22일 07:55. 묶음 S1(매주 목요일 스터디): 22일 10:00(지금 이후 가장 가까움) · 29일 · 15일(지난 회차)
    const occurrence = (id: string, day: number, series: string) =>
      participantRow({ participant_id: `p-${id}` }, { appointment_id: id, series_id: series, title: '스터디', appointment_at: kst('10:00', day), recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' });
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        occurrence('s1-0515', 15, 'S1'),
        occurrence('s1-0529', 29, 'S1'),
        occurrence('s1-0522', 22, 'S1'),
        participantRow({ participant_id: 'p-one' }, { appointment_id: A, series_id: A, title: '팀 주간회의', appointment_at: kst('11:00', 23) }), // 반복 아닌 약속 = 묶음 1개짜리
        participantRow({ participant_id: 'p-old' }, { appointment_id: 'old-1', series_id: 'old-1', title: '지난 약속', appointment_at: kst('10:00', 20) }), // 묶음 1개짜리 지난 약속은 지금처럼 목록에 있음
      ],
    });
    mockRoutes['alarms:select'] = () => ({
      data: [
        { ...alarmRow('00000000-0000-4000-8000-0000000000d1', 'WAKE', '06:00', {}), series_id: 'W', recurrence_rule: 'FREQ=DAILY', scheduled_at: kst('06:00', 23) },
        { ...alarmRow('00000000-0000-4000-8000-0000000000d2', 'WAKE', '06:00', {}), series_id: 'W', recurrence_rule: 'FREQ=DAILY', scheduled_at: kst('06:00', 24) },
      ],
    });
    const list = await real.listAppointments();
    expect(list.map((a) => `${a.id} ${formatTime(a.at)}`)).toEqual(['old-1 오전 10:00', 's1-0522 오전 10:00', '00000000-0000-4000-8000-0000000000d1 오전 6:00', `${A} 오전 11:00`]);
  });

  it('listAppointments({ everyOccurrence }): H05가 같은 날 앞 일정의 기상을 찾을 때는 묶음을 줄이지 않고 모든 회차 (그날의 회차가 가장 가까운 회차가 아닐 수 있음)', async () => {
    const occurrence = (id: string, day: number) =>
      participantRow({ participant_id: `p-${id}` }, { appointment_id: id, series_id: 'S1', title: '스터디', appointment_at: kst('10:00', day), recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' });
    mockRoutes['appointment_participants:select'] = () => ({ data: [occurrence('s1-0522', 22), occurrence('s1-0529', 29), occurrence('s1-0605', 36)] });
    mockRoutes['alarms:select'] = () => ({ data: [] });
    expect((await real.listAppointments()).map((a) => a.id)).toEqual(['s1-0522']);
    expect((await real.listAppointments({ everyOccurrence: true })).map((a) => a.id)).toEqual(['s1-0522', 's1-0529', 's1-0605']);
  });

  it('listAppointments: 앞으로 회차가 둘 이상인 묶음의 한 장에만 남은 회차 수(upcomingCount) — 지난 회차는 안 셈', async () => {
    const occurrence = (id: string, day: number, series: string) =>
      participantRow({ participant_id: `p-${id}` }, { appointment_id: id, series_id: series, title: '스터디', appointment_at: kst('10:00', day), recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' });
    mockRoutes['appointment_participants:select'] = () => ({
      data: [occurrence('s1-0515', 15, 'S1'), occurrence('s1-0522', 22, 'S1'), occurrence('s1-0529', 29, 'S1'), occurrence('s1-0530', 30, 'S1'), occurrence('s2-0529', 29, 'S2')],
    });
    mockRoutes['alarms:select'] = () => ({ data: [] });
    const list = await real.listAppointments();
    expect(list.map((a) => [a.id, a.upcomingCount])).toEqual([
      ['s1-0522', 3],
      ['s2-0529', undefined], // 앞으로 한 장뿐인 묶음
    ]);
  });

  it('listOccurrences: 이 약속의 묶음(series_id)을 읽고, 같은 묶음의 지금 이후 내 참여 조건만 날짜순으로 — 회차마다 앞으로 첫 알람 시각', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    mockRoutes['appointments:select'] = () => ({ data: { series_id: 'S1' } });
    const row = (apptId: string, day: number, alarms: unknown[]) => ({
      appointments: { appointment_id: apptId, series_id: 'S1', appointment_at: kst('10:00', day) },
      alarms,
    });
    mockRoutes['appointment_participants:select'] = () => ({
      data: [row(id, 22, meetingAlarms()), row('s1-0529', 29, [{ alarm_type: 'WAKE', scheduled_at: kst('08:00', 29), is_enabled: false }])],
    });
    const list = await real.listOccurrences(id);
    expect(list.map((o) => [o.id, o.alarmAt && formatTime(o.alarmAt)])).toEqual([
      [id, '오전 8:00'],
      ['s1-0529', null], // 알람을 꺼 둔 회차
    ]);

    const [own] = callsTo('appointments', 'select');
    expect(filterArgs(own, 'eq', 'appointment_id')).toEqual([id]);
    const [read] = callsTo('appointment_participants', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(read, 'eq', 'appointments.series_id')).toEqual(['S1']);
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual(['2025-05-21T22:55:00.000Z']); // 지금(5월 22일 7:55 한국) 이후
    expect(filterArgs(read, 'order', 'appointments(appointment_at)')).toEqual([]);
  });

  it('listOccurrences: 지난 회차는 빼고, 묶음 번호가 없거나 UUID가 아닌 옛 주소는 빈 목록 (참여 조건은 읽지 않음)', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    mockRoutes['appointments:select'] = () => ({ data: { series_id: null } });
    expect(await real.listOccurrences(id)).toEqual([]);
    expect(await real.listOccurrences('m1')).toEqual([]);
    expect(callsTo('appointment_participants', 'select')).toHaveLength(0);

    mockRoutes['appointments:select'] = () => ({ data: { series_id: 'S1' } });
    mockRoutes['appointment_participants:select'] = () => ({
      data: [{ appointments: { appointment_id: 'old', series_id: 'S1', appointment_at: kst('10:00', 15) }, alarms: [] }],
    });
    expect(await real.listOccurrences(id)).toEqual([]);
  });

  it('listAppointments: 가장 가까운 회차의 알람이 모두 없으면(목록에서 빠짐) 그 다음 회차가 대신 보임 — 묶음 전체가 사라지지 않음', async () => {
    const occurrence = (id: string, day: number, alarms: unknown[]) =>
      participantRow({ participant_id: `p-${id}` }, { appointment_id: id, series_id: 'S1', title: '스터디', appointment_at: kst('10:00', day) }, alarms);
    mockRoutes['appointment_participants:select'] = () => ({ data: [occurrence('s1-0522', 22, []), occurrence('s1-0529', 29, meetingAlarms())] });
    const list = await real.listAppointments();
    expect(list.map((a) => a.id)).toEqual(['s1-0529']);
  });

  it('listAppointments: 묶음이 전부 지났으면 가장 최근 지난 회차 하나', async () => {
    const occurrence = (id: string, day: number) => participantRow({ participant_id: `p-${id}` }, { appointment_id: id, series_id: 'S1', title: '스터디', appointment_at: kst('10:00', day) });
    mockRoutes['appointment_participants:select'] = () => ({ data: [occurrence('s1-0508', 8), occurrence('s1-0515', 15)] });
    expect((await real.listAppointments()).map((a) => a.id)).toEqual(['s1-0515']);
  });

  it('listAppointments: 준비물은 약속 id를 100개씩 나눠 읽음 (id를 주소에 실어 보내서 300개면 주소가 너무 길어짐) — 결과는 약속별로 그대로', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    mockRoutes['appointment_participants:select'] = () => ({
      data: ids.map((id, i) => participantRow({ participant_id: `p-${i}` }, { appointment_id: id, title: `일정 ${i}` })),
    });
    mockRoutes['todos:select'] = (call) => {
      const asked = filterArgs(call, 'in', 'appointment_id')?.[0] as string[];
      return { data: asked.filter((id) => id === ids[0] || id === ids[150] || id === ids[249]).map((id) => ({ appointment_id: id, title: `준비물 ${id.slice(-3)}` })) };
    };
    mockRoutes['alarms:select'] = () => ({ data: [] });
    const list = await real.listAppointments();
    const asks = callsTo('todos', 'select').map((c) => (filterArgs(c, 'in', 'appointment_id')?.[0] as string[]).length);
    expect(asks).toEqual([100, 100, 50]);
    expect(list).toHaveLength(250);
    expect(list.filter((a) => a.items.length).map((a) => a.items)).toEqual([['준비물 000'], ['준비물 150'], ['준비물 249']]);
  });

  it('getDaySchedule: 그날 0시 ~ 다음 날 0시, 알람 없는 일정도 한 줄', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        { participant_id: 'p-2', appointments: { appointment_id: 'appt-2', title: '치과 예약', appointment_at: kst('15:30'), dest_name: '동네 치과', importance: 'LOW' }, alarms: [] },
        { participant_id: 'p-1', appointments: { appointment_id: '00000000-0000-4000-8000-0000000000a1', title: '팀 주간회의', appointment_at: kst('10:00'), dest_name: '세종대학교', importance: 'NORMAL' }, alarms: [{ alarm_id: 'a', alarm_type: 'WAKE' }] },
      ],
    });
    const items = await real.getDaySchedule(new Date(kst('00:00')));
    expect(items.map((i) => `${i.title} ${i.hasAlarm}`)).toEqual(['팀 주간회의 true', '치과 예약 false']);
    const [read] = callsTo('appointment_participants', 'select');
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual([new Date(kst('00:00')).toISOString()]);
    expect(filterArgs(read, 'lt', 'appointments.appointment_at')).toEqual([new Date(kst('00:00', 23)).toISOString()]);
    expect(filterArgs(read, 'order', 'appointments(appointment_at)')).toEqual([]);
  });

  it('getAppointment: 저장된 값 + 최근 4주 지각 횟수로 강도 자동 값, 읽은 값은 미리 보기용으로 기억', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 2 } : { data: participantRow() });
    const detail = await real.getAppointment('00000000-0000-4000-8000-0000000000a1');
    expect(detail).toMatchObject({ id: '00000000-0000-4000-8000-0000000000a1', title: '팀 주간회의', level: 1 });
    expect(detail?.intensity).toMatchObject({ lateCount: 2, latePoint: 1, auto: 2 }); // 보통(중요) 1점 + 지각 2번 1점
    expect(recallDetail('00000000-0000-4000-8000-0000000000a1')).toBe(detail);
    const count = mockCalls.find(isCount)!;
    expect(filterArgs(count, 'eq', 'is_late')).toEqual([true]);
    expect(filterArgs(count, 'gte', 'arrived_at')).toEqual(['2025-04-23T22:55:00.000Z']); // 지금 − 28일
  });

  it('getAppointment: 내 잠귀(profiles.wake_sensitivity)를 읽어 강도 자동 값에 넣음 — 무거움이면 지각이 없어도 강, 프로필이 없거나 가벼움은 보통', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    mockRoutes['profiles:select'] = () => ({ data: { wake_sensitivity: 'HEAVY' } });
    const heavy = await real.getAppointment('00000000-0000-4000-8000-0000000000a1');
    expect(heavy?.intensity).toMatchObject({ auto: 2, lateCount: 0 });
    const [read] = callsTo('profiles', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    for (const data of [{ wake_sensitivity: 'LIGHT' }, { wake_sensitivity: 'NORMAL' }, null]) {
      mockRoutes['profiles:select'] = () => ({ data });
      expect((await real.getAppointment('00000000-0000-4000-8000-0000000000a1'))?.intensity.auto).toBe(1);
    }
  });

  it('setIntensity: 잠귀가 무거우면 자동 값(강)을 기준으로 — 진동만 없음으로 고르면 vibration 칸만 NONE, 전체 세기와 나머지 두 칸은 자동 강 (D1 A)', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    mockRoutes['profiles:select'] = () => ({ data: { wake_sensitivity: 'HEAVY' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }] });
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'vibration', 0);
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'STRONG', vibration: 'NONE', voice_tone: 'DIRECT', sound_key: 'theme_urgent', intensity_source: 'MANUAL' });
    mockCalls.length = 0;
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'vibration', null); // 다시 자동 = 강
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'STRONG', vibration: null, voice_tone: 'DIRECT', sound_key: 'theme_urgent', intensity_source: 'AUTO' }); // 다시 자동이면 vibration도 NULL(강도를 따름)
  });

  it('getAppointment: 알람이 없는 일정 · 내 것이 아닌(없는) 일정 · 일정 없는 알람 id는 null', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow({}, {}, []) });
    expect(await real.getAppointment('00000000-0000-4000-8000-0000000000a1')).toBeNull();
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: null });
    expect(await real.getAppointment('00000000-0000-4000-8000-0000000000e1')).toBeNull();
  });

  it('getNextAlarm: 가장 이른 켜진 알람이 일정 없는 알람이면 제목 "알람"으로', async () => {
    mockRoutes['alarms:select'] = (call) =>
      call.columns === 'alarm_id, participant_id'
        ? { data: { alarm_id: '00000000-0000-4000-8000-0000000000c1', participant_id: null } }
        : { data: { ...alarmRow('00000000-0000-4000-8000-0000000000c1', 'WAKE', '08:10'), recurrence_rule: null } };
    const next = await real.getNextAlarm();
    expect(next?.appointment.title).toBe('알람');
    expect(next && formatTime(next.alarm.at)).toBe('오전 8:10');
    const [first] = callsTo('alarms', 'select');
    expect(filterArgs(first, 'is', 'routine_id')).toEqual([null]);
    expect(filterArgs(first, 'in', 'alarm_type')).toEqual([['WAKE', 'PREPARE', 'DEPARTURE']]);
  });

  it('getNextAlarm: 약속 알람이면 그 약속을 읽어 다음 알람을 고름 · 알람이 없으면 null', async () => {
    mockRoutes['alarms:select'] = () => ({ data: { alarm_id: '00000000-0000-4000-8000-0000000000b1', participant_id: 'p-1' } });
    mockRoutes['appointment_participants:select'] = () => ({ data: participantRow() });
    const next = await real.getNextAlarm();
    expect(next?.appointment.title).toBe('팀 주간회의');
    expect(next?.alarm.kind).toBe('WAKE');
    mockRoutes['alarms:select'] = () => ({ data: null });
    expect(await real.getNextAlarm()).toBeNull();
  });

  it('이번만 지운 회차(exception_kind = CANCELED)는 약속 목록 · 하루 일정 · 다음 알람 · 회차 목록 쿼리에서 거름 (NULL은 남김 — 약속 쪽 칸 필터)', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    const notCanceled = (call: FakeCall) => call.filters.find(([method]) => method === 'or');
    const EXPECTED = ['or', 'exception_kind.is.null,exception_kind.neq.CANCELED', { referencedTable: 'appointments' }];

    mockRoutes['appointment_participants:select'] = () => ({ data: [] });
    mockRoutes['alarms:select'] = () => ({ data: [] });
    await real.listAppointments();
    await real.getDaySchedule(new Date(kst('00:00')));
    expect(callsTo('appointment_participants', 'select').map(notCanceled)).toEqual([EXPECTED, EXPECTED]);

    mockCalls.length = 0;
    mockRoutes['alarms:select'] = () => ({ data: { alarm_id: '00000000-0000-4000-8000-0000000000b1', participant_id: 'p-1' } });
    mockRoutes['appointment_participants:select'] = () => ({ data: participantRow() });
    await real.getNextAlarm();
    expect(callsTo('appointment_participants', 'select').map(notCanceled)).toEqual([EXPECTED]);

    mockCalls.length = 0;
    mockRoutes['appointments:select'] = () => ({ data: { series_id: 'S1' } });
    mockRoutes['appointment_participants:select'] = () => ({ data: [] });
    await real.listOccurrences(id);
    expect(callsTo('appointment_participants', 'select').map(notCanceled)).toEqual([EXPECTED]);
  });

  it('읽기 실패는 DB 원문 그대로 던짐 (화면이 LoadError로 기본 문구)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ error: { code: '', message: 'Network request failed' } });
    mockRoutes['alarms:select'] = () => ({ data: [] });
    await expect(real.listAppointments()).rejects.toMatchObject({ message: 'Network request failed' });
  });
});

// ---------------------------------------------------------------------------
// DB 직접 쓰기
// ---------------------------------------------------------------------------

describe('가짜 데이터 시절 주소(UUID가 아닌 id)', () => {
  // 실데이터 모드에서 /alarm/m1 · ?alarm=a1:WAKE 같은 옛 주소가 열려도 uuid 칸에 글자를 묻는 DB 형식 오류(22P02) 대신 "없음"으로 처리
  const old = 'm1';

  it('읽기는 DB에 묻지 않고 없음: getAppointment · previewAlarms · getWakeCheck · confirmWake', async () => {
    expect(await real.getAppointment(old)).toBeNull();
    expect(await real.previewAlarms(old, { bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: null, prepareMinutes: null, times: {} })).toMatchObject({ alarms: [], travelMinutes: 0 });
    expect(await real.getWakeCheck('a1:WAKE')).toBeNull();
    await expect(real.confirmWake('a1:WAKE', 'self')).resolves.toBeUndefined();
    expect(mockCalls.filter((c) => c.table === 'appointment_participants' || c.op !== 'select' || c.table === 'alarm_events')).toEqual([]);
    expect(mockCalls.every((c) => filterArgs(c, 'eq', 'appointment_id') == null && filterArgs(c, 'eq', 'alarm_id') == null)).toBe(true);
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('쓰기는 이유를 UserError로 (DB에 쓰지 않음): setAppointmentEnabled · setAlarmEnabled · setIntensity', async () => {
    await expect(real.setAppointmentEnabled(old, true)).rejects.toBeInstanceOf(UserError);
    await expect(real.setAlarmEnabled(old, 'WAKE', true)).rejects.toBeInstanceOf(UserError);
    await expect(real.setIntensity(old, 'sound', 2)).rejects.toBeInstanceOf(UserError);
    expect(mockCalls.filter((c) => c.op !== 'select')).toEqual([]);
    expect(mockCalls.every((c) => filterArgs(c, 'eq', 'appointment_id') == null && filterArgs(c, 'eq', 'alarm_id') == null)).toBe(true);
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});

describe('켜기 · 끄기 · 강도 (DB 직접 → 그 알람만 폰에 맞춤)', () => {
  it('setAppointmentEnabled: 약속의 알람 전부(도착 목표 포함)를 바꾸고 그 알람만 reconcile', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }, { alarm_id: '00000000-0000-4000-8000-0000000000b2' }, { alarm_id: '00000000-0000-4000-8000-0000000000b3' }, { alarm_id: '00000000-0000-4000-8000-0000000000b4' }] });
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', false);
    const [update] = callsTo('alarms', 'update');
    expect(update.payload).toEqual({ is_enabled: false });
    expect(filterArgs(update, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(filterArgs(update, 'eq', 'user_id')).toEqual(['user-1']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b4'] });
  });

  it('setAppointmentEnabled: 약속이 아니면 일정 없는 알람 id로 (참여 조건 · 루틴 없는 내 알람만)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: null });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000c1' }] });
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000c1', true);
    const [update] = callsTo('alarms', 'update');
    expect(filterArgs(update, 'eq', 'alarm_id')).toEqual(['00000000-0000-4000-8000-0000000000c1']);
    expect(filterArgs(update, 'is', 'participant_id')).toEqual([null]);
    expect(filterArgs(update, 'is', 'routine_id')).toEqual([null]);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['00000000-0000-4000-8000-0000000000c1'] });
  });

  it('setAppointmentEnabled: 없는 알람이면 이유를 UserError로, DB 오류는 그대로', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: null });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    await expect(real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000d1', false)).rejects.toBeInstanceOf(UserError);
    mockRoutes['alarms:update'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000d1', false)).rejects.toMatchObject({ message: 'offline' });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('켤 때는 아직 안 지난 알람만 켬 (지난 기상 알람을 켜면 서버 배치가 울린 적 없는 알람을 기상 미확인으로 기록함) — 끌 때는 전부', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b3' }] });
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', true);
    expect(filterArgs(callsTo('alarms', 'update')[0], 'gt', 'scheduled_at')).toEqual(['2025-05-21T22:55:00.000Z']);
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', false);
    expect(filterArgs(callsTo('alarms', 'update')[1], 'gt', 'scheduled_at')).toBeUndefined();
    mockCalls.length = 0;
    await real.setAlarmEnabled('00000000-0000-4000-8000-0000000000a1', 'WAKE', true);
    expect(filterArgs(callsTo('alarms', 'update')[0], 'gt', 'scheduled_at')).toEqual(['2025-05-21T22:55:00.000Z']);
  });

  it('일정 전체를 켤 때는 울리는 알람(기상 · 준비 · 출발)만 켜고 도착 목표는 그 결과에 맞춤 — 도착 목표만 켜진 채 "켰어요"가 되지 않게', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = (call) => (filterArgs(call, 'neq', 'alarm_type') ? { data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b2' }, { alarm_id: '00000000-0000-4000-8000-0000000000b3' }] } : { data: [] });
    // 기상은 이미 지나 꺼진 채, 준비 · 출발은 방금 켜짐, 도착 목표는 꺼져 있음
    mockRoutes['alarms:select'] = () => ({
      data: [
        { alarm_id: '00000000-0000-4000-8000-0000000000b1', alarm_type: 'WAKE', is_enabled: false },
        { alarm_id: '00000000-0000-4000-8000-0000000000b2', alarm_type: 'PREPARE', is_enabled: true },
        { alarm_id: '00000000-0000-4000-8000-0000000000b3', alarm_type: 'DEPARTURE', is_enabled: true },
        { alarm_id: '00000000-0000-4000-8000-0000000000b4', alarm_type: 'ARRIVE', is_enabled: false },
      ],
    });
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', true);
    const [update, arriveUpdate] = callsTo('alarms', 'update');
    expect(filterArgs(update, 'neq', 'alarm_type')).toEqual(['ARRIVE']);
    expect(arriveUpdate.payload).toEqual({ is_enabled: true });
    expect(filterArgs(arriveUpdate, 'eq', 'alarm_id')).toEqual(['00000000-0000-4000-8000-0000000000b4']);
    expect(mockReconcile).toHaveBeenCalledWith({
      alarmIds: ['00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b4'],
    });
  });

  it('울리는 알람이 모두 지나고 도착 목표만 남은 일정을 켜면 도착 목표를 켜지 않고 이유를 알림', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    await expect(real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', true)).rejects.toThrow('이미 지난');
    expect(callsTo('alarms', 'update')).toHaveLength(1); // 도착 목표를 따로 켜는 쓰기가 없음
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('끌 때는 도착 목표까지 한 번에 (mirrorArrive를 따로 부르지 않음)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'x' }] });
    await real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', false);
    expect(filterArgs(callsTo('alarms', 'update')[0], 'neq', 'alarm_type')).toBeUndefined();
    expect(callsTo('alarms', 'select')).toEqual([]);
  });

  it('켤 알람이 모두 지났으면 이유를 UserError로 (DB는 안 바뀜)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    await expect(real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', true)).rejects.toThrow('이미 지난');
    await expect(real.setAlarmEnabled('00000000-0000-4000-8000-0000000000a1', 'WAKE', true)).rejects.toThrow('이미 지난');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('폰에 걸지 못한 알람이 있으면(정확한 알람 권한 없음 등) UserError — DB에는 이미 씀', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }] });
    mockReconcile.mockResolvedValue({ failed: [{ alarmId: '00000000-0000-4000-8000-0000000000b1', error: '정확한 알람 권한 없음' }] });
    await expect(real.setAppointmentEnabled('00000000-0000-4000-8000-0000000000a1', true)).rejects.toBeInstanceOf(UserError);
    expect(callsTo('alarms', 'update')).toHaveLength(1);
  });

  it('setAlarmEnabled: 그 종류만 바꾸고, 울리는 알람이 모두 꺼지면 도착 목표도 끔', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = (call) => (call.payload && 'is_enabled' in (call.payload as object) && filterArgs(call, 'eq', 'alarm_type') ? { data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b3' }] } : undefined);
    // 이미 기상 · 준비는 꺼져 있고 출발을 끔 -> 모두 꺼짐
    mockRoutes['alarms:select'] = () => ({
      data: [
        { alarm_id: '00000000-0000-4000-8000-0000000000b1', alarm_type: 'WAKE', is_enabled: false },
        { alarm_id: '00000000-0000-4000-8000-0000000000b2', alarm_type: 'PREPARE', is_enabled: false },
        { alarm_id: '00000000-0000-4000-8000-0000000000b3', alarm_type: 'DEPARTURE', is_enabled: false },
        { alarm_id: '00000000-0000-4000-8000-0000000000b4', alarm_type: 'ARRIVE', is_enabled: true },
      ],
    });
    await real.setAlarmEnabled('00000000-0000-4000-8000-0000000000a1', 'DEPARTURE', false);
    const updates = callsTo('alarms', 'update');
    expect(updates[0].payload).toEqual({ is_enabled: false });
    expect(filterArgs(updates[0], 'eq', 'alarm_type')).toEqual(['DEPARTURE']);
    expect(updates[1].payload).toEqual({ is_enabled: false });
    expect(filterArgs(updates[1], 'eq', 'alarm_id')).toEqual(['00000000-0000-4000-8000-0000000000b4']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b4'] });
  });

  it('setIntensity: 한 축을 직접 고르면 그 축 칸만 바뀌고(전체 세기 intensity는 자동 그대로, 진동은 null) 약속의 모든 알람에 쓰고 intensity_source = MANUAL', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }, { alarm_id: '00000000-0000-4000-8000-0000000000b2' }] });
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'sound', 2);
    const [update] = callsTo('alarms', 'update');
    expect(update.payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_urgent', vibration: null, intensity_source: 'MANUAL' });
    expect(filterArgs(update, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2'] });
  });

  it('setIntensity: 다른 칸의 직접 값은 이어 가고, 마지막 직접 값을 자동으로 되돌리면 AUTO', async () => {
    const manualAlarms = [alarmRow('00000000-0000-4000-8000-0000000000b1', 'WAKE', '08:00', { intensity_source: 'MANUAL', sound_key: 'theme_urgent' })];
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow({}, {}, manualAlarms) });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }] });
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'vibration', 0); // 배경음 강 · 진동 약
    // 진동은 vibration 칸 — 전체 세기(intensity)는 자동(보통) 그대로
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_urgent', vibration: 'NONE', intensity_source: 'MANUAL' });
    mockCalls.length = 0;
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'sound', null); // 남은 직접 값이 없음
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, intensity_source: 'AUTO' });
    // 저장된 진동(vibration)이 직접 고른 값으로 읽혀 이어짐: 배경음만 자동으로 되돌려도 진동 약은 남음
    const withVibration = [alarmRow('00000000-0000-4000-8000-0000000000b1', 'WAKE', '08:00', { intensity_source: 'MANUAL', sound_key: 'theme_urgent', vibration: 'NONE' })];
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow({}, {}, withVibration) });
    mockCalls.length = 0;
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'sound', null);
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: 'NONE', intensity_source: 'MANUAL' });
  });

  it('쓰기 뒤 H03의 기억해 둔 저장 값은 지움', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    await real.getAppointment('00000000-0000-4000-8000-0000000000a1');
    expect(recallDetail('00000000-0000-4000-8000-0000000000a1')).toBeDefined();
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1' }] });
    await real.setIntensity('00000000-0000-4000-8000-0000000000a1', 'voice', 2);
    expect(recallDetail('00000000-0000-4000-8000-0000000000a1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 기상 후 아침 흐름 (이슈 #230) — 오늘 첫 일정 · 지금 나가면
// ---------------------------------------------------------------------------

describe('오늘 첫 일정 (getMorningPlan)', () => {
  const WAKE_ID = '00000000-0000-4000-8000-0000000000b1';
  const dayRow = (overrides: Record<string, unknown> = {}, appointment: Record<string, unknown> = {}, alarms: unknown[] = meetingAlarms()) => ({
    participant_id: 'p-1',
    est_travel_minutes: 50,
    travel_source: 'API',
    departed_at: null,
    appointments: { appointment_id: '00000000-0000-4000-8000-0000000000a1', title: '팀 주간회의', appointment_at: kst('10:00'), dest_name: '세종대학교', importance: 'NORMAL', ...appointment },
    alarms,
    ...overrides,
  });
  const readDay = () => callsTo('appointment_participants', 'select')[0];

  it('그날 0시 ~ 다음 날 0시의 내 참여 조건을 읽고, 켜진 기상 알람이 붙은 가장 이른 약속을 칸으로 만듦', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        dayRow({ participant_id: 'p-2' }, { appointment_id: '00000000-0000-4000-8000-0000000000a2', title: '저녁약속', appointment_at: kst('18:00') }, [alarmRow('x1', 'PREPARE', '17:00')]),
        dayRow(),
      ],
    });
    mockRoutes['alarm_events:select'] = () => ({ data: [{ event_at: kst('08:03') }] });

    const plan = await real.getMorningPlan();

    expect(plan).toMatchObject({
      appointmentId: '00000000-0000-4000-8000-0000000000a1',
      title: '팀 주간회의',
      place: '세종대학교',
      wakeAlarmId: WAKE_ID,
      travelMinutes: 50,
      travelSource: '길찾기',
      departedAt: null,
    });
    expect([plan?.at, plan?.prepareAt, plan?.departAt, plan?.arriveAt, plan?.wakeConfirmedAt].map((d) => formatTime(d!))).toEqual(['오전 10:00', '오전 8:30', '오전 9:00', '오전 9:50', '오전 8:03']);

    const read = readDay();
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual([new Date(kst('00:00')).toISOString()]);
    expect(filterArgs(read, 'lt', 'appointments.appointment_at')).toEqual([new Date(kst('00:00', 23)).toISOString()]);
    const confirm = callsTo('alarm_events', 'select')[0];
    expect(filterArgs(confirm, 'eq', 'alarm_id')).toEqual([WAKE_ID]);
    expect(filterArgs(confirm, 'eq', 'event_type')).toEqual(['WAKE_CONFIRMED']);
    expect(filterArgs(confirm, 'eq', 'user_id')).toEqual(['user-1']);
  });

  it('기상 확정 기록이 없으면 wakeConfirmedAt null, 출발 기록이 있으면 departedAt', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: [dayRow({ departed_at: '2025-05-22T00:01:00+00:00', travel_source: 'MANUAL' })] });
    mockRoutes['alarm_events:select'] = () => ({ data: [] });
    const plan = await real.getMorningPlan();
    expect(plan?.wakeConfirmedAt).toBeNull();
    expect(formatTime(plan!.departedAt!)).toBe('오전 9:01');
    expect(plan?.travelSource).toBe('직접 입력');
  });

  it('켜진 기상 알람이 붙은 약속이 없거나(꺼 둠 · 기상 없음) 그날 약속이 없으면 null — 확정 기록은 묻지 않음', async () => {
    const off = meetingAlarms().map((a) => (a.alarm_type === 'WAKE' ? { ...a, is_enabled: false } : a));
    mockRoutes['appointment_participants:select'] = () => ({ data: [dayRow({}, {}, off), dayRow({ participant_id: 'p-3' }, { appointment_at: kst('13:00') }, [])] });
    expect(await real.getMorningPlan()).toBeNull();
    mockRoutes['appointment_participants:select'] = () => ({ data: [] });
    expect(await real.getMorningPlan()).toBeNull();
    expect(callsTo('alarm_events')).toEqual([]);
  });

  it('저녁(18시~)에는 홈처럼 내일 약속을 읽음 — 새벽 약속의 기상 알람은 전날 밤에 울림', async () => {
    mockNow = new Date(kst('21:00')); // 5월 22일 밤 9시
    mockRoutes['appointment_participants:select'] = () => ({ data: [] });
    await real.getMorningPlan();
    const read = readDay();
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual([new Date(kst('00:00', 23)).toISOString()]);
    expect(filterArgs(read, 'lt', 'appointments.appointment_at')).toEqual([new Date(kst('00:00', 24)).toISOString()]);
  });

  it('홈이 하루 일정과 같이 부르면 같은 하루 읽기는 한 번만 (중복 쿼리 없음), 끝난 뒤에는 기억하지 않고 다시 읽음', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: [dayRow()] });
    mockRoutes['alarm_events:select'] = () => ({ data: [] });
    const [schedule, plan] = await Promise.all([real.getDaySchedule(new Date(kst('00:00'))), real.getMorningPlan()]);
    expect(schedule.map((x) => x.title)).toEqual(['팀 주간회의']);
    expect(plan?.title).toBe('팀 주간회의');
    expect(callsTo('appointment_participants', 'select')).toHaveLength(1);

    await real.getMorningPlan();
    expect(callsTo('appointment_participants', 'select')).toHaveLength(2);
  });

  it('기상 확정 기록만 못 읽으면 확정 전으로 보고 계획은 그대로 줌', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: [dayRow()] });
    mockRoutes['alarm_events:select'] = () => ({ error: { code: '', message: 'offline' } });
    const plan = await real.getMorningPlan();
    expect(plan?.wakeConfirmedAt).toBeNull();
    expect(plan?.appointmentId).toBeTruthy();
  });

  it('읽기가 실패하면 그대로 던짐 (홈이 없는 것으로 보고 넘어감)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(real.getMorningPlan()).rejects.toMatchObject({ message: 'offline' });
  });
});

describe('지금 나가면 (checkDepartNow)', () => {
  const ID = '00000000-0000-4000-8000-0000000000a1';

  it('저장된 약속 id만으로 alarm-suggest를 부름 (저장 안 함) — 지금 + 이동 = 도착, 여유 · 상태는 departNow', async () => {
    mockCallEdge.mockResolvedValue(suggestion({ travel: { minutes: 40, source: 'API', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 40 } }));
    const check = await real.checkDepartNow(ID);

    expect(mockCallEdge).toHaveBeenCalledTimes(1);
    expect(mockCallEdge).toHaveBeenCalledWith('alarm-suggest', { appointment_id: ID }, { retry: 1 });
    expect(callsTo('appointments')).toEqual([]);
    expect(mockApplyCommit).not.toHaveBeenCalled();
    // 지금 오전 7:55 + 40분 = 오전 8:35, 약속 10:00 → 여유 85분
    expect([formatTime(check.arriveAt), check.travelMinutes, check.source, check.slackMinutes, check.status, formatTime(check.checkedAt)]).toEqual(['오전 8:35', 40, '길찾기', 85, 'COMFORT', '오전 7:55']);
  });

  it('지금이 늦으면 빠듯 · 지각 위험, 이동 출처는 서버가 준 값의 글자', async () => {
    mockNow = new Date(kst('09:10')); // 도착 09:10 + 50 = 10:00 → 여유 0
    mockCallEdge.mockResolvedValue(suggestion({ travel: { minutes: 50, source: 'ESTIMATE', manual_required: false, needs_confirmation: true, note: null, auto_minutes: 50 } }));
    expect(await real.checkDepartNow(ID)).toMatchObject({ slackMinutes: 0, status: 'TIGHT', source: '대략적인 값' });
    mockNow = new Date(kst('09:30'));
    expect(await real.checkDepartNow(ID)).toMatchObject({ slackMinutes: -20, status: 'LATE_RISK' });
  });

  it('출발 시각이 지나 서버가 UNPROCESSABLE(DEPARTURE_PASSED)을 줘도 details.suggestion의 이동분으로 계산', async () => {
    mockNow = new Date(kst('09:20'));
    const passed = suggestion({ check: { ok: false, reason: 'DEPARTURE_PASSED' }, travel: { minutes: 45, source: 'MANUAL', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 50 } });
    mockCallEdge.mockRejectedValue(new EdgeError('UNPROCESSABLE', { details: { reason: 'DEPARTURE_PASSED', suggestion: passed } }));
    const check = await real.checkDepartNow(ID);
    expect([formatTime(check.arriveAt), check.slackMinutes, check.status, check.source]).toEqual(['오전 10:05', -5, 'LATE_RISK', '직접 입력']);
  });

  it('이동시간을 구하지 못했으면(manual_required) 직접 입력하라는 안내 UserError, 다른 서버 오류는 그대로', async () => {
    mockCallEdge.mockResolvedValue(suggestion({ travel: { minutes: null, source: null, manual_required: true, needs_confirmation: true, note: null, auto_minutes: null } }));
    await expect(real.checkDepartNow(ID)).rejects.toBeInstanceOf(UserError);
    mockCallEdge.mockReset();
    mockCallEdge.mockRejectedValue(new EdgeError('NOT_FOUND'));
    await expect(real.checkDepartNow(ID)).rejects.toMatchObject({ name: 'EdgeError' });
  });

  it('같은 요청이 동시에 겹치면 서버를 한 번만 부르고, 끝난 뒤 다시 누르면 새로 구함 (결과를 기억하지 않음 — D5)', async () => {
    mockCallEdge.mockResolvedValue(suggestion());
    await Promise.all([real.checkDepartNow(ID), real.checkDepartNow(ID)]);
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
    await real.checkDepartNow(ID);
    expect(mockCallEdge).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 장소 · 계산 · 저장
// ---------------------------------------------------------------------------

const suggestion = (overrides: Record<string, unknown> = {}) => ({
  appointment_at: new Date(kst('10:00')).toISOString(),
  arrive_at: new Date(kst('09:50')).toISOString(),
  alarms: [
    { alarm_type: 'WAKE', scheduled_at: new Date(kst('08:00')).toISOString(), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'PREPARE', scheduled_at: new Date(kst('08:30')).toISOString(), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'DEPARTURE', scheduled_at: new Date(kst('09:00')).toISOString(), auto_scheduled_at: null, is_enabled: true },
    { alarm_type: 'ARRIVE', scheduled_at: new Date(kst('09:50')).toISOString(), auto_scheduled_at: null, is_enabled: true },
  ],
  check: { ok: true },
  travel: { minutes: 50, source: 'API', manual_required: false, needs_confirmation: false, note: '길찾기 기준', auto_minutes: 50 },
  prepare: { minutes: 60, auto_minutes: 60, common_p80: 50, correction: 10, sample_count: 10, prior: 10, weight: 0.5, residual_p80: 20, before_prepare_minutes: 30 },
  intensity: { level: 'NORMAL', auto_level: 1, late_point: 0, axes: { sound: { level: 1, manual: false }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } } },
  with_wake: true,
  same_day_wake: false,
  ...overrides,
});

const draft = (overrides: Partial<AppointmentDraft> = {}): AppointmentDraft => ({
  title: '스터디',
  date: new Date(kst('00:00', 23)),
  time: '10:00',
  repeat: [],
  place: '세종대학교',
  transport: 'TRANSIT',
  importance: 'LOW',
  items: '노트북',
  alarms: defaultAlarms(),
  placeLat: 37.55,
  placeLng: 127.07,
  ...overrides,
});

const commitResponse = (overrides: Record<string, unknown> = {}) => ({
  appointment_id: 'new-appt',
  participant_id: 'new-part',
  alarms: [
    { alarm_id: 'n-wake', alarm_type: 'WAKE', scheduled_at: kst('08:00', 23), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null },
    { alarm_id: 'n-arrive', alarm_type: 'ARRIVE', scheduled_at: kst('09:50', 23), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', vibration: null, time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null },
  ],
  ring_packages: [{ alarmId: 'n-wake' }],
  canceled_alarm_ids: [],
  ...overrides,
});

describe('장소 (listPlaces)', () => {
  it('검색어가 있으면 place-search, 결과의 좌표를 이름으로 기억해 둠', async () => {
    mockCallEdge.mockResolvedValue({ places: [{ id: '1', name: '세종대학교', address: '서울 광진구', lat: 37.55, lng: 127.07 }, { id: '2', name: '세종대학교', lat: 1, lng: 2 }, { id: '3', name: '주소만' }] });
    const places = await real.listPlaces(' 세종 ');
    expect(mockCallEdge).toHaveBeenCalledWith('place-search', { query: '세종', limit: 10 }, { retry: 1 });
    expect(places).toEqual([{ name: '세종대학교', address: '서울 광진구', lat: 37.55, lng: 127.07 }, { name: '주소만' }]); // 같은 이름은 먼저 나온 것만, 좌표 없으면 좌표 칸 없음
    expect(lookupPlace('세종대학교')).toMatchObject({ lat: 37.55, lng: 127.07 });
    expect(lookupPlace('주소만')).toBeUndefined();
  });

  it('near(집 좌표)를 주면 place-search의 lat · lng로 넘겨 가까운 순으로 받음, 둘 중 하나라도 숫자가 아니면 안 넘김', async () => {
    mockCallEdge.mockResolvedValue({ places: [] });
    await real.listPlaces('세종', { lat: 37.5, lng: 127.0 });
    expect(mockCallEdge).toHaveBeenLastCalledWith('place-search', { query: '세종', lat: 37.5, lng: 127.0, limit: 10 }, { retry: 1 });
    await real.listPlaces('세종', { lat: Number.NaN, lng: 127.0 });
    expect(mockCallEdge).toHaveBeenLastCalledWith('place-search', { query: '세종', limit: 10 }, { retry: 1 });
  });

  it('서버가 준 category는 그대로 통과 (없으면 칸 없음) — 기억해 두는 좌표 쪽은 이름 · 좌표만 씀', async () => {
    mockCallEdge.mockResolvedValue({ places: [{ id: '1', name: '세종대학교', lat: 37.55, lng: 127.07, category: '교육,학문 > 대학교' }, { id: '2', name: '건대 앞 카페', lat: 37.54, lng: 127.07 }] });
    const places = await real.listPlaces('대', { lat: 37.5, lng: 127.0 });
    expect(places).toEqual([
      { name: '세종대학교', lat: 37.55, lng: 127.07, category: '교육,학문 > 대학교' },
      { name: '건대 앞 카페', lat: 37.54, lng: 127.07 },
    ]);
    expect(toPoint('세종대학교')).toEqual({ name: '세종대학교', lat: 37.55, lng: 127.07 }); // 길찾기 요청에는 category가 실리지 않음
  });

  it('검색어가 없으면 최근에 쓴 곳(최근 약속의 도착지 · 출발지, "집" 제외) — 서버 함수를 부르지 않음', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        { origin_name: '집', origin_lat: 37.5, origin_lng: 127.0, appointments: { dest_name: '학교 도서관', dest_lat: 37.1, dest_lng: 127.1, appointment_at: kst('09:00', 20) } },
        { origin_name: '세종대학교', origin_lat: 37.55, origin_lng: 127.07, appointments: { dest_name: '강남역', dest_lat: 37.49, dest_lng: 127.03, appointment_at: kst('18:00', 21) } },
        { origin_name: '현재 위치', origin_lat: 37.55, origin_lng: 126.97, appointments: { dest_name: '학교 도서관', dest_lat: 37.1, dest_lng: 127.1, appointment_at: kst('18:00', 20) } },
      ],
    });
    const places = await real.listPlaces();
    expect(mockCallEdge).not.toHaveBeenCalled();
    expect(places.map((p) => p.name)).toEqual(['강남역', '학교 도서관', '세종대학교']); // 최근 약속의 도착지 먼저
    expect(lookupPlace('강남역')).toMatchObject({ lat: 37.49 });
  });
});

describe('핀 자리 주소 (reverseAddress)', () => {
  it('place-reverse에 좌표를 보내고 도로명 주소를 우선, 건물 이름이 있으면 같이 돌려줌 — 기억해 두지 않음', async () => {
    mockCallEdge.mockResolvedValue({ place: { address: '서울 광진구 화양동 1', roadAddress: '서울 광진구 능동로 209', buildingName: '세종대학교 광개토관' } });
    await expect(real.reverseAddress(37.55, 127.07)).resolves.toEqual({ address: '서울 광진구 능동로 209', name: '세종대학교 광개토관' });
    expect(mockCallEdge).toHaveBeenCalledWith('place-reverse', { lat: 37.55, lng: 127.07 }, { retry: 1 });
    expect(lookupPlace('세종대학교 광개토관')).toBeUndefined();
  });

  it('도로명 주소가 없으면 지번 주소, 건물 이름이 비면 이름 칸 없음', async () => {
    mockCallEdge.mockResolvedValue({ place: { address: '서울 광진구 화양동 1', roadAddress: ' ', buildingName: '' } });
    await expect(real.reverseAddress(37.55, 127.07)).resolves.toEqual({ address: '서울 광진구 화양동 1' });
  });

  it('주소를 못 구한 자리(place null · 빈 주소)와 범위 밖 좌표는 null — 범위 밖은 서버를 부르지 않음', async () => {
    mockCallEdge.mockResolvedValue({ place: null });
    await expect(real.reverseAddress(33, 124)).resolves.toBeNull();
    mockCallEdge.mockResolvedValue({ place: { address: null, roadAddress: null } });
    await expect(real.reverseAddress(33, 124)).resolves.toBeNull();
    mockCallEdge.mockClear();
    await expect(real.reverseAddress(95, 127)).resolves.toBeNull();
    await expect(real.reverseAddress(Number.NaN, 127)).resolves.toBeNull();
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('서버 오류는 그대로 던짐 (화면이 "주소를 못 불러왔어요"로 바꿈)', async () => {
    mockCallEdge.mockRejectedValue(new Error('PLACE_UNAVAILABLE'));
    await expect(real.reverseAddress(37.55, 127.07)).rejects.toThrow();
  });
});

describe('새 일정 계산 · 저장 (H05)', () => {
  it('estimateAppointment: alarm-suggest에 새 일정 요청을 보내고 확인 시트 값을 만듦', async () => {
    mockCallEdge.mockResolvedValue(suggestion());
    const estimate = await real.estimateAppointment(draft());
    const [name, body, options] = mockCallEdge.mock.calls[0];
    expect(name).toBe('alarm-suggest');
    expect(body).toMatchObject({ appointment: { title: '스터디', destination: { name: '세종대학교', lat: 37.55, lng: 127.07 }, importance: 'LOW' }, kinds: ['WAKE', 'PREPARE', 'DEPARTURE'] });
    expect(options).toEqual({ retry: 1 });
    expect(estimate.appointment.alarms.map((a) => `${a.kind} ${formatTime(a.at)}`)).toEqual(['WAKE 오전 8:00', 'PREPARE 오전 8:30', 'DEPARTURE 오전 9:00', 'ARRIVE 오전 9:50']);
    expect(estimate.commit?.travelSource).toBe('API');
  });

  it('장소를 안 골랐거나 좌표가 없어 이동시간을 못 구하면 이유를 UserError로 (H05에는 직접 입력 칸이 없음)', async () => {
    await expect(real.estimateAppointment(draft({ place: ' ' }))).rejects.toBeInstanceOf(UserError);
    expect(mockCallEdge).not.toHaveBeenCalled();
    mockCallEdge.mockResolvedValue(
      suggestion({ alarms: [], travel: { minutes: null, source: null, manual_required: true, needs_confirmation: true, note: null, auto_minutes: null }, check: { ok: false, reason: 'TRAVEL_REQUIRED', message: '이동시간을 직접 입력해 주세요' } }),
    );
    await expect(real.estimateAppointment(draft({ placeLat: undefined, placeLng: undefined }))).rejects.toThrow('위치를 몰라');
  });

  it('출발 시각까지 지난 일정은 서버가 계산 결과를 같이 줘도 저장할 수 없다고 알림', async () => {
    const departurePassed = suggestion({ check: { ok: false, reason: 'DEPARTURE_PASSED', message: '출발 시각이 이미 지나서 저장할 수 없어요' } });
    mockCallEdge.mockRejectedValue(new EdgeError('UNPROCESSABLE', { details: { reason: 'DEPARTURE_PASSED', suggestion: departurePassed } }));
    await expect(real.estimateAppointment(draft())).rejects.toThrow('출발 시각이 이미 지나서 저장할 수 없어요');
  });

  it('저장할 수 없는 입력이면 서버 check.message 원문 대신 reason으로 앱 문구를 보여 줌, 모르는 이유는 기본 문구', async () => {
    const english = 'alarms.WAKE must be earlier than alarms.PREPARE';
    mockCallEdge.mockResolvedValue(suggestion({ check: { ok: false, reason: 'ORDER', message: english } }));
    const order = await real.estimateAppointment(draft()).catch((e: unknown) => e);
    expect(order).toBeInstanceOf(UserError);
    expect((order as UserError).message).toBe('알람 순서가 맞지 않아요. 기상 → 준비 → 출발 순서로 맞춰 주세요');

    mockCallEdge.mockResolvedValue(suggestion({ check: { ok: false, reason: 'NEW_REASON', message: english } }));
    const unknown = await real.estimateAppointment(draft({ title: '다른 일정' })).catch((e: unknown) => e);
    expect((unknown as UserError).message).toBe('이 내용으로는 저장할 수 없어요');
  });

  it('같은 계산 요청이 동시에 두 번 가면 서버에는 한 번', async () => {
    mockCallEdge.mockResolvedValue(suggestion());
    await Promise.all([real.estimateAppointment(draft()), real.estimateAppointment(draft())]);
    expect(mockCallEdge).toHaveBeenCalledTimes(1);
  });

  const estimateOf = async (d = draft()): Promise<Estimate> => {
    mockCallEdge.mockResolvedValueOnce(suggestion());
    return real.estimateAppointment(d);
  };

  it('createAppointment: alarm-commit(고친 값 기록 포함) -> 폰 예약 -> 준비물 todos, 서버가 만든 id로 돌려줌', async () => {
    const estimate = await estimateOf();
    // 확인 시트에서 기상을 7:45로 직접 고름
    const alarms = estimate.appointment.alarms.map((a) => (a.kind === 'WAKE' ? { ...a, at: new Date(kst('07:45')), auto: a.at } : a));
    const picked = { ...estimate, appointment: { ...estimate.appointment, alarms } };
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockRoutes['todos:insert'] = () => undefined;
    const saved = await real.createAppointment(picked);

    const [name, body, options] = mockCallEdge.mock.calls[1];
    expect(name).toBe('alarm-commit');
    expect(options).toEqual({ timeoutMs: 30_000 }); // 쓰기는 자동 재시도 없음 (중복 키를 서버가 아직 안 읽음)
    expect(body).toMatchObject({
      participant: { est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 60 },
      manual_times: { WAKE: new Date(kst('07:45')).toISOString() },
      edits: [{ screen: 'H05', field: 'scheduled_at', alarm_type: 'WAKE' }],
    });
    expect(mockApplyCommit).toHaveBeenCalledWith(expect.objectContaining({ appointment_id: 'new-appt' }));
    expect(callsTo('todos', 'insert')[0].payload).toEqual([{ user_id: 'user-1', appointment_id: 'new-appt', title: '노트북', todo_type: 'ITEM', due_date: '2025-05-23' }]);
    expect(saved.id).toBe('new-appt');
    expect(saved.alarms.map((a) => a.id)).toEqual(['n-wake', 'n-arrive']);
  });

  it('createAppointment: 반복 일정이면 준비물 저장 뒤에 그 묶음(= 약속 id)의 회차를 넘기라고 syncNow를 부름, 반복이 아니면 안 부름', async () => {
    const order: string[] = [];
    mockRoutes['todos:insert'] = () => {
      order.push('todos');
      return undefined;
    };
    mockSyncNow.mockImplementation(async () => {
      order.push('syncNow');
    });
    const repeating = await estimateOf(draft({ repeat: ['목'] }));
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.createAppointment(repeating);
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    expect(mockSyncNow).toHaveBeenCalledWith({ rollSeriesId: 'new-appt' });
    expect(order).toEqual(['todos', 'syncNow']); // 서버가 회차를 만들며 복사할 준비물이 먼저 저장돼 있어야 함

    mockSyncNow.mockClear();
    const once = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.createAppointment(once);
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('createAppointment: 회차 넘기기가 실패해도(던져도) 저장은 성공 — 기다리지도 않음', async () => {
    const repeating = await estimateOf(draft({ repeat: ['목'] }));
    mockSyncNow.mockImplementation(() => new Promise(() => {})); // 끝나지 않아도 저장이 안 막힘
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await expect(real.createAppointment(repeating)).resolves.toMatchObject({ id: 'new-appt' });
    mockSyncNow.mockImplementation(() => {
      throw new Error('동기 오류');
    });
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await expect(real.createAppointment(repeating)).resolves.toMatchObject({ id: 'new-appt' });
  });

  it('createAppointment: applyCommit에 약속 시각을 같이 넘김 (맞춘 뒤 훅의 upcoming용)', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.createAppointment(estimate);
    expect(mockApplyCommit).toHaveBeenCalledWith(expect.objectContaining({ participant_id: 'new-part', appointment_at: new Date(kst('10:00', 23)).toISOString() }));
  });

  it('저장 뒤처리(폰 예약 · 준비물)가 실패해도 오류로 돌리지 않음 — 다시 보내면 일정이 하나 더 생김', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockApplyCommit.mockRejectedValue(new Error('폰 오류'));
    await expect(real.createAppointment(estimate)).resolves.toMatchObject({ id: 'new-appt' });
    mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'n-wake', error: '권한 없음' }] });
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockRoutes['todos:insert'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(real.createAppointment(estimate)).resolves.toMatchObject({ id: 'new-appt' });
  });

  it('뒤처리가 다 되면 followUp 없음 — 화면은 원래 저장 문구', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockRoutes['todos:insert'] = () => undefined;
    expect((await real.createAppointment(estimate)).followUp).toBeUndefined();
  });

  it('폰에 못 건 알람 · 못 넣은 준비물은 followUp으로 돌려줌 (화면이 "저장했지만 ~못 했어요"로 알림)', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'n-wake', error: '권한 없음' }] });
    mockRoutes['todos:insert'] = () => undefined;
    expect((await real.createAppointment(estimate)).followUp).toEqual({ phoneFailed: 1, itemsFailed: false });

    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockApplyCommit.mockResolvedValue({ failed: [] });
    mockRoutes['todos:insert'] = () => ({ error: { code: '', message: 'offline' } });
    expect((await real.createAppointment(estimate)).followUp).toEqual({ phoneFailed: 0, itemsFailed: true });
  });

  it('폰 예약이 통째로 던져도 준비물은 넣고, 걸려던 알람 모두를 못 건 것으로 셈', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockResolvedValueOnce(commitResponse({ ring_packages: [{ alarmId: 'n-wake' }, { alarmId: 'n-arrive' }] }));
    mockApplyCommit.mockRejectedValue(new Error('폰 오류'));
    mockRoutes['todos:insert'] = () => undefined;
    const saved = await real.createAppointment(estimate);
    expect(callsTo('todos', 'insert')).toHaveLength(1);
    expect(saved.followUp).toEqual({ phoneFailed: 2, itemsFailed: false });
  });

  it('저장 요청이 서버에서 거절되면 그대로 던짐 (폰 예약 · 준비물은 안 건드림)', async () => {
    const estimate = await estimateOf();
    mockCallEdge.mockRejectedValueOnce(new EdgeError('UNPROCESSABLE', { details: { reason: 'ORDER' } }));
    await expect(real.createAppointment(estimate)).rejects.toBeInstanceOf(UserError);
    expect(mockApplyCommit).not.toHaveBeenCalled();
    expect(callsTo('todos')).toEqual([]);
  });

  it('알람 순서가 뒤집힌 확인 시트는 서버에 보내지 않고 이유를 알림 (가짜와 같은 문구)', async () => {
    const estimate = await estimateOf();
    const alarms = estimate.appointment.alarms.map((a) => (a.kind === 'WAKE' ? { ...a, at: new Date(kst('09:30', 23)), auto: a.at } : a));
    await expect(real.createAppointment({ ...estimate, appointment: { ...estimate.appointment, alarms } })).rejects.toThrow('빠를 수 없어요');
    expect(mockCallEdge).toHaveBeenCalledTimes(1); // 계산 한 번뿐
  });

  it('가짜 데이터로 만든 계산 결과(서버 요청 조각 없음)는 저장하지 않고 다시 계산하라고 알림', async () => {
    const estimate = await estimateOf();
    const { commit, ...withoutCommit } = estimate;
    void commit;
    await expect(real.createAppointment(withoutCommit)).rejects.toThrow('다시 계산');
  });
});

describe('알람 설정 미리 보기 · 저장 (H03)', () => {
  const loaded = async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    return (await real.getAppointment('00000000-0000-4000-8000-0000000000a1'))!;
  };
  const same = (d: Awaited<ReturnType<typeof loaded>>): AlarmSettingsDraft => ({
    ...d.edits,
    kinds: { WAKE: true, PREPARE: true, DEPARTURE: true },
    levels: { sound: null, voice: null, vibration: null },
  });

  it('previewAlarms: 읽어 둔 저장 값으로 요청을 만들어 alarm-suggest에 보냄 — 저장 값을 다시 읽지 않음', async () => {
    const detail = await loaded();
    mockCalls.length = 0;
    mockCallEdge.mockResolvedValue(suggestion({ travel: { minutes: 40, source: 'MANUAL', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 55 } }));
    const preview = await real.previewAlarms('00000000-0000-4000-8000-0000000000a1', { ...detail.edits, travelMinutes: 40 });
    expect(mockCalls).toEqual([]);
    expect(mockCallEdge.mock.calls[0][1]).toMatchObject({ appointment_id: '00000000-0000-4000-8000-0000000000a1', participant: { est_travel_minutes: 40, travel_source: 'MANUAL' } });
    expect(preview).toMatchObject({ travelMinutes: 40, travelSource: '직접 입력', autoTravelMinutes: 55 });
  });

  it('previewAlarms: 출발 시각까지 지난 일정은 서버가 오류로 줘도 계산 결과로 미리 보기를 보여 줌', async () => {
    const detail = await loaded();
    mockCallEdge.mockRejectedValue(new EdgeError('UNPROCESSABLE', { details: { reason: 'DEPARTURE_PASSED', suggestion: suggestion({ check: { ok: false, reason: 'DEPARTURE_PASSED' } }) } }));
    await expect(real.previewAlarms('00000000-0000-4000-8000-0000000000a1', detail.edits)).resolves.toMatchObject({ travelMinutes: 50 });
    mockCallEdge.mockRejectedValue(new EdgeError('NETWORK'));
    await expect(real.previewAlarms('00000000-0000-4000-8000-0000000000a1', detail.edits)).rejects.toBeInstanceOf(UserError);
  });

  it('saveAlarmSettings: 종류만 바꾸면 계산 없이 저장 — enabled · levels · 고친 값 기록(alarm_enabled)', async () => {
    const detail = await loaded();
    mockCalls.length = 0;
    mockCallEdge.mockResolvedValue(
      commitResponse({
        alarms: ['WAKE', 'PREPARE', 'DEPARTURE'].map((t) => ({ ...commitResponse().alarms[0], alarm_id: t, alarm_type: t, is_enabled: t !== 'WAKE' })),
      }),
    );
    mockRoutes['alarms:select'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1', alarm_type: 'WAKE', is_enabled: false }, { alarm_id: '00000000-0000-4000-8000-0000000000b4', alarm_type: 'ARRIVE', is_enabled: true }] });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    const result = await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } });

    expect(mockCallEdge).toHaveBeenCalledTimes(1);
    const [name, body] = mockCallEdge.mock.calls[0];
    expect(name).toBe('alarm-commit');
    expect(body).toMatchObject({
      appointment_id: '00000000-0000-4000-8000-0000000000a1',
      enabled: { WAKE: false, PREPARE: true, DEPARTURE: true },
      levels: { sound: null, voice: null, vibration: null },
      edits: [{ screen: 'H03', field: 'alarm_enabled', alarm_type: 'WAKE', auto_value: true, edited_value: false }],
    });
    expect(mockApplyCommit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ turnedOff: false, turnedOn: false }); // 준비 · 출발은 아직 켜져 있음
  });

  it('saveAlarmSettings: 이동시간 같은 시각 입력을 바꾸면 먼저 계산해서 고친 값 기록의 자동값을 구함', async () => {
    const detail = await loaded();
    mockCallEdge.mockResolvedValueOnce(suggestion({ travel: { minutes: 40, source: 'MANUAL', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 55 } }));
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    mockRoutes['alarms:select'] = () => ({ data: [] });
    await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), travelMinutes: 40 });
    expect(mockCallEdge.mock.calls.map(([name]) => name)).toEqual(['alarm-suggest', 'alarm-commit']);
    expect((mockCallEdge.mock.calls[1][1] as { edits: unknown }).edits).toEqual([{ screen: 'H03', field: 'travel_minutes', auto_value: 55, edited_value: 40 }]);
  });

  it('saveAlarmSettings: 알람 순서가 뒤집히면 저장하지 않고 이유를 알림, 이동시간을 못 구하면 예상 이동에 직접 입력하라고', async () => {
    const detail = await loaded();
    mockCallEdge.mockResolvedValueOnce(
      suggestion({
        alarms: [
          { alarm_type: 'WAKE', scheduled_at: new Date(kst('09:30')).toISOString(), auto_scheduled_at: new Date(kst('08:00')).toISOString(), is_enabled: true },
          { alarm_type: 'DEPARTURE', scheduled_at: new Date(kst('09:00')).toISOString(), auto_scheduled_at: null, is_enabled: true },
        ],
        check: { ok: false, reason: 'ORDER' },
      }),
    );
    await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), times: { WAKE: new Date(kst('09:30')) } })).rejects.toThrow('빠를 수 없어요');
    expect(mockCallEdge).toHaveBeenCalledTimes(1);

    mockCallEdge.mockResolvedValueOnce(suggestion({ alarms: [], travel: { minutes: null, source: null, manual_required: true, needs_confirmation: true, note: null, auto_minutes: null } }));
    await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), origin: '모르는 곳' })).rejects.toThrow('직접 입력');
  });

  describe('saveAlarmSettings: 길찾기를 못 해 서버가 어림값만 가졌을 때 (7장 7.1.2 "근사값은 사용자 확인 → MANUAL")', () => {
    const A1 = '00000000-0000-4000-8000-0000000000a1';
    const fallbackError = (source: string, minutes: number) =>
      new EdgeError('ROUTE_UNAVAILABLE', { status: 502, details: { manual_required: true, fallback: { minutes, source, needs_confirmation: source === 'ESTIMATE', sample_count: null } } });

    it('종류만 바꿔도 길찾기가 안 되면 저장하지 않고 확인을 요청 — 폰 예약은 안 건드리고 쌓인 고친 값 기록도 그대로', async () => {
      const detail = await loaded();
      mockRoutes['alarms:select'] = () => ({ data: [] });
      await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: A1, alarmType: 'WAKE', autoValue: new Date(kst('08:00')), editedValue: new Date(kst('07:50')) });
      mockCallEdge.mockRejectedValueOnce(fallbackError('ESTIMATE', 63.4));
      const error = await real.saveAlarmSettings(A1, { ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TravelConfirmNeeded);
      expect(error).toBeInstanceOf(UserError);
      expect(error).toMatchObject({ minutes: 63, source: 'ESTIMATE' });
      expect(mockApplyCommit).not.toHaveBeenCalled();
      expect(peekEdits(A1)).toHaveLength(1);
    });

    it('확인하면 그 분을 직접 입력(MANUAL)으로 다시 보내 저장 — 자동값과 같은 값이라 이동시간 고친 값 기록은 남기지 않음', async () => {
      const detail = await loaded();
      mockRoutes['alarms:select'] = () => ({ data: [] });
      const draftOff = { ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } };
      mockCallEdge.mockRejectedValueOnce(fallbackError('ESTIMATE', 63));
      await expect(real.saveAlarmSettings(A1, draftOff)).rejects.toBeInstanceOf(TravelConfirmNeeded);

      mockCallEdge.mockResolvedValueOnce(suggestion({ travel: { minutes: 63, source: 'MANUAL', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 63 } }));
      mockCallEdge.mockResolvedValueOnce(commitResponse());
      await real.saveAlarmSettings(A1, { ...draftOff, travelMinutes: 63 });
      expect(mockCallEdge.mock.calls.map(([name]) => name)).toEqual(['alarm-commit', 'alarm-suggest', 'alarm-commit']);
      const body = mockCallEdge.mock.calls[2][1] as { participant: Record<string, unknown>; edits: unknown[] };
      expect(body.participant).toMatchObject({ est_travel_minutes: 63, travel_source: 'MANUAL' });
      expect(body.edits).toEqual([expect.objectContaining({ field: 'alarm_enabled' })]);
      expect(mockApplyCommit).toHaveBeenCalledTimes(1);
    });

    it('내 지난 이동 기록 중앙값(CACHED)도 같은 길 — 출처를 화면에 알려 줌', async () => {
      const detail = await loaded();
      mockCallEdge.mockRejectedValueOnce(fallbackError('CACHED', 45));
      await expect(real.saveAlarmSettings(A1, same(detail))).rejects.toMatchObject({ minutes: 45, source: 'CACHED' });
    });

    it('어림값이 없는 ROUTE_UNAVAILABLE(좌표도 없음)이나 이미 직접 입력한 값을 보냈는데 같은 오류면 확인을 되풀이하지 않고 그대로 던짐', async () => {
      const detail = await loaded();
      const noFallback = new EdgeError('ROUTE_UNAVAILABLE', { status: 502, details: { manual_required: true, fallback: null } });
      mockCallEdge.mockRejectedValueOnce(noFallback);
      await expect(real.saveAlarmSettings(A1, same(detail))).rejects.toBe(noFallback);

      mockCallEdge.mockResolvedValueOnce(suggestion());
      const again = fallbackError('ESTIMATE', 63);
      mockCallEdge.mockRejectedValueOnce(again);
      await expect(real.saveAlarmSettings(A1, { ...same(detail), travelMinutes: 40 })).rejects.toBe(again);
    });
  });

  it('saveAlarmSettings: 종류를 모두 껐으면 turnedOff, 껐던 것을 다시 켜면 turnedOn', async () => {
    const detail = await loaded();
    const allOff = commitResponse({ alarms: ['WAKE', 'PREPARE', 'DEPARTURE'].map((t) => ({ ...commitResponse().alarms[0], alarm_id: t, alarm_type: t, is_enabled: false })) });
    mockCallEdge.mockResolvedValueOnce(allOff);
    mockRoutes['alarms:select'] = () => ({ data: [] });
    expect(await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), kinds: { WAKE: false, PREPARE: false, DEPARTURE: false } })).toEqual({ turnedOff: true, turnedOn: false });

    mockRoutes['appointment_participants:select'] = (call) =>
      isCount(call) ? { count: 0 } : { data: participantRow({}, {}, meetingAlarms().map((a) => ({ ...a, is_enabled: false }))) };
    const offDetail = (await real.getAppointment('00000000-0000-4000-8000-0000000000a1'))!;
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    expect(await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(offDetail), kinds: { WAKE: true, PREPARE: false, DEPARTURE: false } })).toEqual({ turnedOff: false, turnedOn: true });
  });

  describe('saveAlarmSettings: 저장(alarm-commit)이 끝난 뒤의 뒤처리(폰 예약 · 도착 목표 맞추기)는 실패해도 실패로 돌리지 않음', () => {
    const turnOffWake = (detail: Awaited<ReturnType<typeof loaded>>): AlarmSettingsDraft => ({ ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } });

    it('폰에 못 건 알람이 있어도(정확한 알람 권한 없음 등) 저장은 성공 — 다음 맞추기(앱이 앞에 올 때)에서 다시 걸림', async () => {
      const detail = await loaded();
      mockCallEdge.mockResolvedValue(commitResponse());
      mockRoutes['alarms:select'] = () => ({ data: [] });
      mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'n-wake', error: '정확한 알람 권한 없음' }] });
      await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', turnOffWake(detail))).resolves.toEqual({
        turnedOff: false,
        turnedOn: false,
        followUp: { phoneFailed: 1, itemsFailed: false }, // 화면이 "저장했지만 알람 1개를 폰에 걸지 못했어요"로 알림
      });
    });

    it('폰 예약이 던지거나 도착 목표 맞추기가 실패해도 저장은 성공 — 둘은 서로 영향 없이 각각 시도', async () => {
      const detail = await loaded();
      mockCallEdge.mockResolvedValue(commitResponse());
      mockApplyCommit.mockRejectedValue(new Error('native'));
      mockRoutes['alarms:select'] = () => ({ error: { message: 'offline' } }); // 도착 목표 맞추기의 읽기가 실패
      await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', turnOffWake(detail))).resolves.toBeDefined();
      expect(callsTo('alarms', 'select')).toHaveLength(1); // 폰 예약이 던졌어도 도착 목표 맞추기는 시도함

      mockApplyCommit.mockResolvedValue({ failed: [] });
      mockRoutes['alarms:select'] = () => ({ data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b4', alarm_type: 'ARRIVE', is_enabled: true }] });
      mockRoutes['alarms:update'] = () => ({ data: [] });
      mockReconcile.mockRejectedValue(new Error('read failed'));
      await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...same(detail), kinds: { WAKE: false, PREPARE: false, DEPARTURE: false } })).resolves.toBeDefined();
    });

    it('도착 목표를 폰에 못 건 것도 followUp에 셈 (홈 빨간 줄과 같은 기준) — 폰 예약에서도 못 건 같은 알람은 한 번', async () => {
      const B4 = '00000000-0000-4000-8000-0000000000b4';
      const detail = await loaded();
      mockCallEdge.mockResolvedValue(commitResponse());
      mockRoutes['alarms:select'] = () => ({ data: [{ alarm_id: B4, alarm_type: 'ARRIVE', is_enabled: true }] }); // 울리는 알람이 없는데 도착 목표가 켜짐 → 끔 + 폰에 맞춤
      mockRoutes['alarms:update'] = () => ({ data: [] });
      mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'n-wake', error: '권한 없음' }, { alarmId: B4, error: '권한 없음' }] });
      mockReconcile.mockResolvedValue({ failed: [{ alarmId: B4, error: '권한 없음' }] });
      expect((await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', turnOffWake(detail))).followUp).toEqual({ phoneFailed: 2, itemsFailed: false });
      expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: [B4] });

      mockApplyCommit.mockResolvedValue({ failed: [] }); // 도착 목표만 못 건 경우
      expect((await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', turnOffWake(detail))).followUp).toEqual({ phoneFailed: 1, itemsFailed: false });
    });

    it('서버가 저장을 거절하면(뒤처리 이전) 그대로 던짐', async () => {
      const detail = await loaded();
      mockCallEdge.mockRejectedValue(new EdgeError('UNPROCESSABLE', { details: { reason: 'DEPARTURE_PASSED' } }));
      await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', turnOffWake(detail))).rejects.toBeInstanceOf(EdgeError);
      expect(mockApplyCommit).not.toHaveBeenCalled();
    });
  });

  it('saveAlarmSettings: 저장과 따로 쌓인 고친 값 기록(recordEdit)을 같은 일정의 저장에 실어 보내고, 성공하면 비움', async () => {
    const detail = await loaded();
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: '00000000-0000-4000-8000-0000000000a1', alarmType: 'WAKE', autoValue: new Date(kst('08:00')), editedValue: new Date(kst('07:50')) });
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: 'other', alarmType: 'WAKE', autoValue: 1, editedValue: 2 });
    mockRoutes['alarms:select'] = () => ({ data: [] });

    mockCallEdge.mockRejectedValueOnce(new EdgeError('NETWORK'));
    await expect(real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', same(detail))).rejects.toBeInstanceOf(UserError);
    expect(peekEdits('00000000-0000-4000-8000-0000000000a1')).toHaveLength(1); // 저장이 실패하면 큐에 남음

    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', same(detail));
    expect((mockCallEdge.mock.calls.at(-1)?.[1] as { edits: unknown }).edits).toEqual([
      { screen: 'S01', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: new Date(kst('08:00')).toISOString(), edited_value: new Date(kst('07:50')).toISOString() },
    ]);
    expect(peekEdits('00000000-0000-4000-8000-0000000000a1')).toEqual([]);
    expect(peekEdits('other')).toHaveLength(1); // 다른 일정의 기록은 그 일정의 저장을 기다림
  });
});

describe('고친 값 기록 줄 수 상한 (서버 edits 50)', () => {
  it('쌓인 기록은 50줄까지만 두고, 한 번의 저장에는 이번 줄 + 남는 자리만큼만 실음 — 못 보낸 것은 큐에 남아 다음 저장에', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    const detail = (await real.getAppointment('00000000-0000-4000-8000-0000000000a1'))!;
    for (let i = 0; i < 60; i++) {
      await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: '00000000-0000-4000-8000-0000000000a1', alarmType: 'WAKE', autoValue: i, editedValue: i + 1 });
    }
    expect(peekEdits('00000000-0000-4000-8000-0000000000a1')).toHaveLength(50); // 쌓는 쪽 상한
    mockRoutes['alarms:select'] = () => ({ data: [] });
    mockCallEdge.mockResolvedValueOnce(suggestion({ travel: { minutes: 40, source: 'MANUAL', manual_required: false, needs_confirmation: false, note: null, auto_minutes: 55 } }));
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.saveAlarmSettings('00000000-0000-4000-8000-0000000000a1', { ...detail.edits, kinds: { WAKE: true, PREPARE: true, DEPARTURE: true }, levels: { sound: null, voice: null, vibration: null }, travelMinutes: 40 });
    const edits = (mockCallEdge.mock.calls.at(-1)?.[1] as { edits: unknown[] }).edits;
    expect(edits).toHaveLength(50);
    expect(edits[0]).toMatchObject({ screen: 'H03', field: 'travel_minutes' }); // 이번 저장의 줄이 먼저
    expect(peekEdits('00000000-0000-4000-8000-0000000000a1')).toHaveLength(1); // 못 실은 한 줄은 다음 저장에
  });
});

describe('로그아웃 · 계정 전환 때 메모리 비우기 (resetAlarmMemory)', () => {
  it('읽어 둔 알람 설정 · 쌓인 고친 값 기록 · 기억해 둔 장소 좌표를 모두 비움', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    await real.getAppointment('00000000-0000-4000-8000-0000000000a1');
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: '00000000-0000-4000-8000-0000000000a1', autoValue: 1, editedValue: 2 });
    mockCallEdge.mockResolvedValue({ places: [{ id: '1', name: '세종대학교', lat: 37.55, lng: 127.07 }] });
    await real.listPlaces('세종');
    resetAlarmMemory();
    expect(recallDetail('00000000-0000-4000-8000-0000000000a1')).toBeUndefined();
    expect(peekEdits('00000000-0000-4000-8000-0000000000a1')).toEqual([]);
    expect(lookupPlace('세종대학교')).toBeUndefined();
  });
});

describe('일정 없는 알람 (D46)', () => {
  const standaloneResponse = () => ({
    alarm_id: '00000000-0000-4000-8000-0000000000c1',
    alarms: [{ alarm_id: '00000000-0000-4000-8000-0000000000c1', alarm_type: 'WAKE', scheduled_at: kst('07:00', 23), is_enabled: true, intensity: 'STRONG', voice_tone: 'DIRECT', sound_key: 'theme_urgent', vibration: null, time_source: 'MANUAL', intensity_source: 'MANUAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' }],
    ring_packages: [{ alarmId: '00000000-0000-4000-8000-0000000000c1' }],
    canceled_alarm_ids: [],
  });

  it('만들기: STANDALONE 요청 -> 폰 예약, 목록이 그리는 일정 모양(제목 "알람")으로 돌려줌', async () => {
    mockCallEdge.mockResolvedValue(standaloneResponse());
    const saved = await real.saveStandaloneAlarm({ at: new Date(kst('07:00', 23)), repeat: ['월'], level: 2 });
    expect(mockCallEdge.mock.calls[0][1]).toEqual({
      type: 'STANDALONE',
      alarm: { scheduled_at: new Date(kst('07:00', 23)).toISOString(), recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', levels: { sound: 2, voice: 2, vibration: 2 } },
      edits: [],
    });
    expect(mockApplyCommit).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ id: '00000000-0000-4000-8000-0000000000c1', title: '알람', standalone: true, repeatLabel: '매주 월요일', level: 2 });
  });

  it('폰에 못 걸었으면 followUp — 폰 예약이 던져도 저장은 성공하고 반복 회차 넘기기는 그대로', async () => {
    mockCallEdge.mockResolvedValue(standaloneResponse());
    mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: '00000000-0000-4000-8000-0000000000c1', error: '정확한 알람 권한 없음' }] });
    expect((await real.saveStandaloneAlarm({ at: new Date(kst('07:00', 23)) })).followUp).toEqual({ phoneFailed: 1, itemsFailed: false });

    mockApplyCommit.mockRejectedValue(new Error('native'));
    const saved = await real.saveStandaloneAlarm({ at: new Date(kst('07:00', 23)), repeat: ['월'] });
    expect(saved).toMatchObject({ id: '00000000-0000-4000-8000-0000000000c1', followUp: { phoneFailed: 1, itemsFailed: false } });
    expect(mockSyncNow).toHaveBeenCalledWith({ rollSeriesId: '00000000-0000-4000-8000-0000000000c1' });
  });

  it('새로 만든 반복 알람이면 그 묶음(= 첫 알람 id)의 회차를 넘기라고 syncNow를 부름 — 반복이 아니거나 고치기면 안 부름', async () => {
    mockCallEdge.mockResolvedValue(standaloneResponse());
    await real.saveStandaloneAlarm({ at: new Date(kst('07:00', 23)), repeat: ['월'] });
    expect(mockSyncNow).toHaveBeenCalledWith({ rollSeriesId: '00000000-0000-4000-8000-0000000000c1' });

    mockSyncNow.mockClear();
    await real.saveStandaloneAlarm({ alarmId: '00000000-0000-4000-8000-0000000000c1', level: 0 }); // 고치기: 어느 회차인지 몰라 건너뜀
    mockCallEdge.mockResolvedValue({ ...standaloneResponse(), alarms: [{ ...standaloneResponse().alarms[0], recurrence_rule: null }] });
    await real.saveStandaloneAlarm({ at: new Date(kst('07:00', 23)) });
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('고치기: 알람 id만 있으면 시각 없이 강도 · 켜기만 보냄, 만들기인데 시각이 없으면 UserError', async () => {
    mockCallEdge.mockResolvedValue(standaloneResponse());
    await real.saveStandaloneAlarm({ alarmId: '00000000-0000-4000-8000-0000000000c1', level: 0 });
    expect((mockCallEdge.mock.calls[0][1] as { alarm: unknown }).alarm).toEqual({ alarm_id: '00000000-0000-4000-8000-0000000000c1', levels: { sound: 0, voice: 0, vibration: 0 } });
    await expect(real.saveStandaloneAlarm({ level: 1 })).rejects.toBeInstanceOf(UserError);
  });
});

describe('고친 값 기록 읽기 (listEditLogs)', () => {
  it('내 기록을 오래된 순으로 화면 모양으로 돌려줌', async () => {
    mockRoutes['user_edit_logs:select'] = () => ({
      data: [
        { created_at: '2025-05-22T02:00:00+00:00', screen: 'H03', field: 'buffer_minutes', appointment_id: '00000000-0000-4000-8000-0000000000a1', alarm_id: null, alarm_type: null, auto_value: 10, edited_value: 15 },
        { created_at: '2025-05-22T01:00:00+00:00', screen: 'H05', field: 'scheduled_at', appointment_id: '00000000-0000-4000-8000-0000000000a1', alarm_id: '00000000-0000-4000-8000-0000000000b1', alarm_type: 'WAKE', auto_value: '2025-05-21T23:00:00Z', edited_value: '2025-05-21T22:45:00Z' },
      ],
    });
    const logs = await real.listEditLogs();
    expect(logs.map((l) => l.field)).toEqual(['scheduled_at', 'buffer_minutes']); // 최근순으로 읽은 것을 뒤집어 오래된 순
    expect(logs[0]).toMatchObject({ screen: 'H05', alarmId: '00000000-0000-4000-8000-0000000000b1', alarmType: 'WAKE' });
    const [read] = callsTo('user_edit_logs', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(mockCalls.some((c) => c.table === 'user_edit_logs' && c.op !== 'select')).toBe(false); // 따로 insert하지 않음
  });
});

// ---------------------------------------------------------------------------
// 울림 · 기상 확인
// ---------------------------------------------------------------------------

describe('울림 (H07) — 알람 코어가 지금 울리는 알람을 읽어 그리고, 해제 · 미루기는 알람 코어로 잇음', () => {
  const ringing = {
    id: 'alarm-1',
    type: 'WAKE',
    title: '팀 주간회의',
    subtitle: null,
    atMillis: Date.parse('2025-05-22T07:55:00+09:00'),
    nextRingAt: Date.parse('2025-05-22T08:00:00+09:00'),
    snoozeCount: 1,
    snoozeLimit: 3,
    snoozeMinutesOptions: [5, 10, 15],
    departAtMillis: Date.parse('2025-05-22T09:00:00+09:00'),
    heading: '일어날 시간이에요',
    soundKey: 'theme_default',
    vibration: 'SHORT_REPEAT',
    intensity: 'STRONG',
  };

  it('getRing: 코어의 울리는 알람을 RingInfo로 바꿈 (제목 · 미루기 횟수 · 한도 · 출발 시각), 약속 정보는 빈 값', async () => {
    mockNow = new Date(kst('07:56'));
    mockCore.getRinging.mockResolvedValue(ringing);
    const ring = await real.getRing('alarm-1');
    expect(ring).toMatchObject({
      alarmId: 'alarm-1',
      kind: 'WAKE',
      notice: '일어날 시간이에요',
      voiceLine: '',
      snoozeCount: 1,
      snoozeLimit: 3,
      important: false,
    });
    expect(ring?.appointment.title).toBe('팀 주간회의');
    expect(ring?.appointment.place).toBe('');
    expect(ring?.at.getTime()).toBe(Date.parse(kst('07:56'))); // 지금 시각
    expect(ring?.departAt?.getTime()).toBe(ringing.departAtMillis);
    expect(ring?.levelLine).toContain('강');
  });

  it('getRing: 울리는 알람이 없거나 다른 알람이거나 울림이 아닌 종류면 null', async () => {
    mockCore.getRinging.mockResolvedValue(null);
    expect(await real.getRing('alarm-1')).toBeNull();
    mockCore.getRinging.mockResolvedValue(ringing);
    expect(await real.getRing('other')).toBeNull();
    mockCore.getRinging.mockResolvedValue({ ...ringing, type: 'ARRIVE' });
    expect(await real.getRing('alarm-1')).toBeNull();
    mockCore.getRinging.mockResolvedValue({ ...ringing, departAtMillis: null });
    expect((await real.getRing('alarm-1'))?.departAt).toBeNull();
  });

  it('해제: 알람 코어 stop 다음에 잠금화면 위 설정을 되돌리며 잠금 해제를 요청', async () => {
    const order: string[] = [];
    mockCore.stop.mockImplementation(async () => void order.push('stop'));
    mockCore.releaseRingOverLock.mockImplementation(async (dismissKeyguard) => void order.push(`release:${dismissKeyguard}`));
    await real.dismissRing();
    expect(order).toEqual(['stop', 'release:true']);
  });

  it('해제: 되돌리기가 실패해도(옛 APK) 해제는 끝난 것으로 둠', async () => {
    mockCore.releaseRingOverLock.mockRejectedValue(new Error('no function'));
    await expect(real.dismissRing()).resolves.toBeUndefined();
    expect(mockCore.stop).toHaveBeenCalledTimes(1);
  });

  it('미루기: 코어 snooze 성공 뒤에만 되돌리고(잠금 해제 요청 없이) true, 코어가 거절하면 되돌리지 않고 false', async () => {
    mockCore.releaseRingOverLock.mockResolvedValue(undefined);
    mockCore.snooze.mockResolvedValue(true);
    expect(await real.snoozeRing('alarm-1', 10)).toBe(true);
    expect(mockCore.snooze).toHaveBeenCalledWith(10);
    expect(mockCore.releaseRingOverLock).toHaveBeenCalledWith(false);

    mockCore.releaseRingOverLock.mockClear();
    mockCore.snooze.mockResolvedValue(false);
    expect(await real.snoozeRing('alarm-1', 10)).toBe(false);
    expect(mockCore.releaseRingOverLock).not.toHaveBeenCalled();
  });

  it('ackRing: 코어에 알리고, 옛 APK에서 던져도 조용히 넘어감', () => {
    real.ackRing();
    expect(mockCore.ackRingScreen).toHaveBeenCalledTimes(1);
    mockCore.ackRingScreen.mockImplementation(() => {
      throw new Error('no function');
    });
    expect(() => real.ackRing()).not.toThrow();
  });

  it('getSnooze: 폰이 미루기 예약을 가진 알람 중 다시 울릴 시각이 가장 이른 것 · cancelSnooze는 폰 예약 지움', async () => {
    const now = Date.parse(kst('07:55'));
    mockCore.list.mockResolvedValue([
      { id: 'later', type: 'PREPARE', title: '팀 주간회의', atMillis: now - 60_000, snoozeCount: 1, nextRingAt: now + 20 * 60_000 },
      { id: 'soon', type: 'WAKE', title: '팀 주간회의', atMillis: now - 60_000, snoozeCount: 2, nextRingAt: now + 5 * 60_000 },
      { id: 'no-snooze', type: 'WAKE', title: '다시 울림 아님', atMillis: now, snoozeCount: 0, nextRingAt: now + 3 * 60_000 },
      { id: 'arrive', type: 'ARRIVE', title: '도착', atMillis: now, snoozeCount: 1, nextRingAt: now + 60_000 },
    ]);
    const snooze = await real.getSnooze();
    expect(snooze).toMatchObject({ alarmId: 'soon', kind: 'WAKE', appointmentTitle: '팀 주간회의', minutes: 10 });
    expect(snooze && formatTime(snooze.at)).toBe('오전 8:00');
    await real.cancelSnooze('soon');
    expect(mockCore.cancel).toHaveBeenCalledWith('soon');
    mockCore.list.mockResolvedValue([]);
    expect(await real.getSnooze()).toBeNull();
  });

  describe('cancelSnooze — 기상 알람의 미루기 취소는 해제로 기록 (H01 -> H08)', () => {
    const WAKE_ID = '00000000-0000-4000-8000-0000000000b1';
    const first = Date.parse(kst('08:00'));
    const waiting = (type: string, atMillis = first) => ({ id: WAKE_ID, type, title: '팀 주간회의', atMillis, snoozeCount: 1, nextRingAt: first + 10 * 60_000 });

    it('기상 알람: DISMISSED(MANUAL)를 먼저 남기고 폰 예약을 지운 뒤 기상 확인으로 이어가라고 알림', async () => {
      mockNow = new Date(Date.parse(kst('08:05')));
      mockCore.list.mockResolvedValue([waiting('WAKE')]);
      const order: string[] = [];
      mockCore.cancel.mockImplementation(async () => {
        order.push('cancel');
      });
      mockRoutes['alarm_events:upsert'] = () => {
        order.push('record');
        return undefined;
      };
      expect(await real.cancelSnooze(WAKE_ID)).toEqual({ wakeCheck: true });
      expect(order).toEqual(['record', 'cancel']);
      const [recorded] = callsTo('alarm_events', 'upsert');
      expect(recorded.payload).toEqual({
        user_id: 'user-1',
        alarm_id: WAKE_ID,
        event_type: 'DISMISSED',
        event_at: new Date(Date.parse(kst('08:05'))).toISOString(),
        client_event_id: expect.stringMatching(UUID),
        input_source: 'MANUAL',
      });
      expect(recorded.options).toEqual({ onConflict: 'client_event_id', ignoreDuplicates: true });
      expect(mockCore.cancel).toHaveBeenCalledWith(WAKE_ID);
    });

    it('기록 번호는 그 알람의 그 회차로 정한 고정 값 — 다시 눌러도 같고, 다음 회차(처음 예약 시각이 다름)는 다름', async () => {
      mockCore.list.mockResolvedValue([waiting('WAKE')]);
      await real.cancelSnooze(WAKE_ID);
      await real.cancelSnooze(WAKE_ID);
      mockCore.list.mockResolvedValue([waiting('WAKE', first + 24 * 3_600_000)]);
      await real.cancelSnooze(WAKE_ID);
      const ids = callsTo('alarm_events', 'upsert').map((c) => (c.payload as { client_event_id: string }).client_event_id);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    });

    it('기록이 막히면(오프라인) 폰 예약을 그대로 두고 던짐 — 알람이 다시 울리고 다시 누를 수 있음', async () => {
      mockCore.list.mockResolvedValue([waiting('WAKE')]);
      mockRoutes['alarm_events:upsert'] = () => ({ error: { code: '', message: 'offline' } });
      await expect(real.cancelSnooze(WAKE_ID)).rejects.toMatchObject({ message: 'offline' });
      expect(mockCore.cancel).not.toHaveBeenCalled();
    });

    it('기록은 됐는데 폰 예약 지우기가 실패하면 던짐 — 다시 누르면 같은 번호라 기록은 한 줄', async () => {
      mockCore.list.mockResolvedValue([waiting('WAKE')]);
      mockCore.cancel.mockRejectedValueOnce(new Error('native'));
      await expect(real.cancelSnooze(WAKE_ID)).rejects.toThrow('native');
      await expect(real.cancelSnooze(WAKE_ID)).resolves.toEqual({ wakeCheck: true });
      const ids = callsTo('alarm_events', 'upsert').map((c) => (c.payload as { client_event_id: string }).client_event_id);
      expect(new Set(ids).size).toBe(1);
    });

    it('기상이 아닌 알람이거나 폰 목록에 없으면 지금대로 예약만 지움 — 기록 없음, 기상 확인으로 이어가지 않음', async () => {
      mockCore.list.mockResolvedValue([waiting('PREPARE')]);
      expect(await real.cancelSnooze(WAKE_ID)).toEqual({ wakeCheck: false });
      mockCore.list.mockResolvedValue([]);
      expect(await real.cancelSnooze(WAKE_ID)).toEqual({ wakeCheck: false });
      expect(mockCore.cancel).toHaveBeenCalledTimes(2);
      expect(callsTo('alarm_events', 'upsert')).toEqual([]);
    });

    it('이 해제 기록으로 H08 판정이 시작됨 (취소한 시각부터 관찰 10분)', async () => {
      const cancelledAt = Date.parse(kst('08:05'));
      mockRoutes['alarms:select'] = () => ({ data: { alarm_id: WAKE_ID, alarm_type: 'WAKE', appointment_participants: { appointments: { title: '팀 주간회의', group_id: null, groups: null } } } });
      mockRoutes['alarm_events:select'] = () => ({ data: [{ event_type: 'DISMISSED', event_at: new Date(cancelledAt).toISOString(), input_source: 'MANUAL' }] });
      mockNow = new Date(cancelledAt + 2 * 60_000);
      const check = await real.getWakeCheck(WAKE_ID);
      expect(check).toMatchObject({ phase: 'observing', confirmed: null });
      expect(check?.dismissedAt.getTime()).toBe(cancelledAt);
    });
  });
});

describe('기상 확인 (H08)', () => {
  const DISMISSED = Date.parse(kst('08:00'));
  const min = (m: number) => DISMISSED + m * 60_000;
  const eventAt = (m: number) => new Date(min(m)).toISOString();

  // 알람 한 줄 + 그 알람의 DISMISSED / WAKE_CONFIRMED 기록
  function setup(events: { event_type: string; event_at: string; input_source?: string | null }[], opts: { appointment?: Record<string, unknown> | null } = {}) {
    mockRoutes['alarms:select'] = () => ({
      data: { alarm_id: '00000000-0000-4000-8000-0000000000b1', alarm_type: 'WAKE', appointment_participants: { appointments: opts.appointment === undefined ? { title: '팀 주간회의', group_id: 'cap', groups: { group_name: '캡스톤팀' } } : opts.appointment } },
    });
    mockRoutes['alarm_events:select'] = () => ({ data: events });
    mockRoutes['alarm_events:upsert'] = () => undefined;
    mockRoutes['daily_records:select'] = () => ({ data: null });
    mockRoutes['daily_records:insert'] = () => undefined;
  }
  // 현재 시각 = 해제 + m분 (실데이터 모드의 지금 시각을 흉내)
  const at = (m: number) => {
    mockNow = new Date(min(m));
  };

  it('해제 기록이 없으면(아직 울리는 중) null — 먼저 폰의 울림 기록을 올림', async () => {
    setup([]);
    at(1);
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1')).toBeNull();
    expect(mockUploadEvents).toHaveBeenCalledTimes(1);
  });

  it('기상 알람이 아니거나 없는 알람이면 null', async () => {
    mockRoutes['alarms:select'] = () => ({ data: { alarm_id: '00000000-0000-4000-8000-0000000000b3', alarm_type: 'DEPARTURE', appointment_participants: null } });
    mockRoutes['alarm_events:select'] = () => ({ data: [] });
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000b3')).toBeNull();
    mockRoutes['alarms:select'] = () => ({ data: null });
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000d1')).toBeNull();
  });

  it('해제 뒤 10분 안: 관찰 중 — 지금까지의 사용 시간, 그룹 일정이면 그룹 이름', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(4);
    mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(0.5), endMillis: min(1.5) }]);
    const check = await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1');
    expect(check).toMatchObject({ alarmId: '00000000-0000-4000-8000-0000000000b1', appointmentTitle: '팀 주간회의', groupId: 'cap', groupName: '캡스톤팀', phase: 'observing', usage: 1, recent: 0, thetaMinutes: 1, confirmed: null });
    expect(check?.dismissedAt.getTime()).toBe(min(0));
    expect(mockCore.getUsageSpans).toHaveBeenCalledWith(min(0), min(4)); // 지금까지만 읽음
    expect(callsTo('alarm_events', 'upsert')).toEqual([]);
  });

  it('10분이 끝났고 조건을 채웠으면 자동 확정 — event_at은 θ를 넘은 시각, 입력 출처 USAGE, 그날 기록에도 남김', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    mockCore.getUsageSpans.mockResolvedValue([
      { startMillis: min(0.5), endMillis: min(1.5) },
      { startMillis: min(6), endMillis: min(7) },
    ]);
    const check = await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1');
    expect(check?.confirmed).toEqual({ at: new Date(min(1.5)), how: 'auto' });
    expect(mockCore.getUsageSpans).toHaveBeenCalledWith(min(0), min(10));
    const [confirmed] = callsTo('alarm_events', 'upsert');
    expect(confirmed.payload).toEqual({
      user_id: 'user-1',
      alarm_id: '00000000-0000-4000-8000-0000000000b1',
      event_type: 'WAKE_CONFIRMED',
      event_at: new Date(min(1.5)).toISOString(),
      client_event_id: expect.stringMatching(UUID),
      input_source: 'USAGE',
    });
    expect(confirmed.options).toEqual({ onConflict: 'client_event_id', ignoreDuplicates: true }); // 번호가 같은 기록은 한 줄만
    expect(callsTo('daily_records', 'insert')[0].payload).toEqual({
      user_id: 'user-1',
      record_date: '2025-05-22',
      wake_confirmed_at: new Date(min(1.5)).toISOString(),
      wake_reported_at: new Date(min(0)).toISOString(),
      data_source: 'ALARM',
    });
  });

  it('조건을 못 채웠거나 사용 정보를 못 읽으면 확인 알림 단계 — 기록은 아직 안 남김', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(0.2), endMillis: min(0.4) }]);
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1')).toMatchObject({ phase: 'prompt', usage: 0.2, confirmed: null });
    mockCore.hasUsageAccess.mockResolvedValue(false);
    at(1);
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1')).toMatchObject({ phase: 'prompt', usage: 0, recent: 0 });
    mockCore.hasUsageAccess.mockResolvedValue(true);
    mockCore.getUsageSpans.mockRejectedValue(new Error('안드로이드 9 미만'));
    expect(await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1')).toMatchObject({ phase: 'prompt' });
    expect(callsTo('alarm_events', 'upsert')).toEqual([]);
  });

  it('올리지 못한 해제 기록(폰에 남은 것)도 해제 시각으로 씀', async () => {
    setup([]);
    at(2);
    mockCore.getPendingEvents.mockResolvedValue([{ clientEventId: 'e1', alarmId: '00000000-0000-4000-8000-0000000000b1', alarmType: 'WAKE', eventType: 'DISMISSED', at: min(0), sequenceNo: 1, inputSource: 'BUTTON' }]);
    expect((await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1'))?.dismissedAt.getTime()).toBe(min(0));
  });

  it('이미 확정한 알람은 처음 판정 그대로 — 다시 쓰지 않음', async () => {
    setup([
      { event_type: 'DISMISSED', event_at: eventAt(0) },
      { event_type: 'WAKE_CONFIRMED', event_at: eventAt(2), input_source: 'BUTTON' },
    ]);
    at(60);
    const check = await real.getWakeCheck('00000000-0000-4000-8000-0000000000b1');
    expect(check?.confirmed).toEqual({ at: new Date(min(2)), how: 'self' });
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('alarm_events', 'upsert')).toEqual([]);
  });

  it('confirmWake(self): 지금 시각으로 WAKE_CONFIRMED(BUTTON) + 그날 기록, 두 번 눌러도(동시) 한 번만', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    await Promise.all([real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self'), real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self')]);
    const writes = callsTo('alarm_events', 'upsert');
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ event_type: 'WAKE_CONFIRMED', event_at: new Date(min(12)).toISOString(), input_source: 'BUTTON' });
    expect(callsTo('daily_records', 'insert')).toHaveLength(1);
  });

  it('그날 기록이 이미 있으면 빈 칸(기상 확인 시각)만 채우고 있던 값은 덮지 않음', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: null, wake_reported_at: '2025-05-21T22:59:00Z' } });
    mockRoutes['daily_records:update'] = () => undefined;
    at(12);
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('daily_records', 'insert')).toEqual([]);
    expect(callsTo('daily_records', 'update')[0].payload).toEqual({ wake_confirmed_at: new Date(min(12)).toISOString() });

    mockCalls.length = 0;
    mockRoutes['alarm_events:select'] = () => ({ data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: '2025-05-21T23:01:00Z', wake_reported_at: '2025-05-21T22:59:00Z' } });
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('daily_records', 'update')).toEqual([]); // 처음 확인 시각을 그대로
  });

  it('기록 중 같은 날 행이 그 사이 생겨 insert가 겹치면(23505) 빈 칸만 채움', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['daily_records:insert'] = () => ({ error: { code: '23505', message: 'duplicate key' } });
    mockRoutes['daily_records:update'] = () => undefined;
    at(12);
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('daily_records', 'update')).toHaveLength(1);
  });

  it('confirmWake(auto): θ를 넘은 시각으로 기록 (못 구하면 지금)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(15);
    mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(2), endMillis: min(3.5) }]);
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'auto');
    expect(callsTo('alarm_events', 'upsert')[0].payload).toMatchObject({ event_at: new Date(min(3)).toISOString(), input_source: 'USAGE' });
  });

  it('기록 쓰기가 실패하면 던짐 (화면이 다시 누를 수 있게 풀어 줌)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:upsert'] = () => ({ error: { code: '', message: 'offline' } });
    at(12);
    await expect(real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self')).rejects.toMatchObject({ message: 'offline' });
    mockRoutes['alarm_events:upsert'] = () => undefined;
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: new Date(min(12)).toISOString(), wake_reported_at: new Date(min(0)).toISOString() } });
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('alarm_events', 'upsert')).toHaveLength(2); // 이벤트를 다시 씀 (확정으로 보지 않음)
  });

  it('그날 기록을 쓰다 끊겨도 확정으로 보지 않음 — 그날 기록을 먼저 쓰고 이벤트는 마지막에, 다시 누르면 이벤트만 쓰고 그날 기록은 건너뜀', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['daily_records:insert'] = () => ({ error: { code: '', message: 'offline' } });
    at(12);
    await expect(real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self')).rejects.toMatchObject({ message: 'offline' });
    expect(callsTo('alarm_events', 'upsert')).toEqual([]); // 이벤트(확정의 표지)가 없어야 다음에 다시 시도됨

    // 다시 누름: 그날 기록은 이미 채워짐(앞 시도에서 insert는 됐다고 보고) -> 건너뛰고 이벤트만
    mockCalls.length = 0;
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: new Date(min(12)).toISOString(), wake_reported_at: new Date(min(0)).toISOString() } });
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect(callsTo('daily_records', 'insert')).toEqual([]);
    expect(callsTo('daily_records', 'update')).toEqual([]);
    expect(callsTo('alarm_events', 'upsert')).toHaveLength(1);
    const order = mockCalls.map((c) => `${c.table}.${c.op}`).filter((x) => x === 'daily_records.select' || x === 'alarm_events.upsert');
    expect(order).toEqual(['daily_records.select', 'alarm_events.upsert']);
  });

  it('확정 이벤트 번호는 그 알람의 그 해제로 정해진 고정 값 — 다시 눌러도 겹쳐 불려도 같은 번호(서버가 한 줄만 남김), 다른 해제면 다른 번호', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    mockNow = new Date(min(13)); // 한 분 뒤 다시 (앞 시도가 실패했다고 보고) — 시각이 달라도 번호는 같음
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    const [first, second] = callsTo('alarm_events', 'upsert').map((c) => (c.payload as { client_event_id: string }).client_event_id);
    expect(first).toMatch(UUID);
    expect(second).toBe(first);

    // 다음 날 같은 알람을 다시 끈 경우(다른 해제 시각)는 다른 번호
    mockCalls.length = 0;
    setup([{ event_type: 'DISMISSED', event_at: new Date(min(0) + 24 * 60 * 60_000).toISOString() }]);
    mockNow = new Date(min(12) + 24 * 60 * 60_000);
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    expect((callsTo('alarm_events', 'upsert')[0].payload as { client_event_id: string }).client_event_id).not.toBe(first);
  });

  it('읽는 사이에 다른 호출이 먼저 확정해 겹쳐도 같은 번호로 upsert — 이벤트가 둘 생기지 않음', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    // 둘 다 "아직 확정 전"으로 읽은 뒤 차례로 쓰는 경우 (settle의 동시 방지는 쓰는 동안만 막음)
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    await real.confirmWake('00000000-0000-4000-8000-0000000000b1', 'self');
    const ids = callsTo('alarm_events', 'upsert').map((c) => (c.payload as { client_event_id: string }).client_event_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('getWakeCheck: 알람 id가 없으면 가장 최근에 끈 기상 알람 (12시간 안)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:select'] = (call) => (call.columns?.includes('alarms!inner') ? { data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] } : { data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    at(3);
    expect((await real.getWakeCheck())?.alarmId).toBe('00000000-0000-4000-8000-0000000000b1');
    const finder = mockCalls.find((c) => c.columns?.includes('alarms!inner'))!;
    expect(filterArgs(finder, 'eq', 'event_type')).toEqual(['DISMISSED']);
    expect(filterArgs(finder, 'eq', 'alarms.alarm_type')).toEqual(['WAKE']);
    expect(filterArgs(finder, 'gte', 'event_at')).toEqual([new Date(min(3) - 12 * 60 * 60_000).toISOString()]);
  });

  it('getWakeInProgress: 해제 뒤 40분(관찰 10 + 응답 여유 30) 안이고 확정 전일 때만', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:select'] = (call) => (call.columns?.includes('alarms!inner') ? { data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] } : { data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    at(20);
    mockCore.getUsageSpans.mockResolvedValue([]);
    expect(await real.getWakeInProgress()).toMatchObject({ alarmId: '00000000-0000-4000-8000-0000000000b1', phase: 'prompt' });
    const finder = mockCalls.find((c) => c.columns?.includes('alarms!inner'))!;
    expect(filterArgs(finder, 'gte', 'event_at')).toEqual([new Date(min(20) - 40 * 60_000).toISOString()]);

    // 확정한 뒤에는 없음
    mockRoutes['alarm_events:select'] = (call) =>
      call.columns?.includes('alarms!inner')
        ? { data: [{ alarm_id: '00000000-0000-4000-8000-0000000000b1', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] }
        : { data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }, { event_type: 'WAKE_CONFIRMED', event_at: eventAt(3), input_source: 'BUTTON' }] };
    expect(await real.getWakeInProgress()).toBeNull();

    // 최근에 끈 기상 알람이 없으면 없음
    mockRoutes['alarm_events:select'] = () => ({ data: [] });
    expect(await real.getWakeInProgress()).toBeNull();
  });

  it('홈의 덧붙임 줄(진행 중인 기상 확인 · 미룬 알람)은 못 읽어도 던지지 않고 없는 것으로 — 홈 전체가 막히지 않게', async () => {
    mockRoutes['alarm_events:select'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(real.getWakeInProgress()).resolves.toBeNull();
    mockCore.list.mockRejectedValue(new Error('폰 예약을 못 읽음'));
    await expect(real.getSnooze()).resolves.toBeNull();
  });

  it('확인 알림 · 놓침은 앱이 기록하지 않음 (놓침 MISSED는 서버 배치, 다시 울림 없음 — D2 = B)', async () => {
    await real.promptWake();
    expect(mockCalls).toEqual([]);
  });

  describe('recheckRecentWakes — 앱이 앞에 올 때 최근에 끈 기상 알람 중 확정이 없는 것을 다시 판정', () => {
    const A = '00000000-0000-4000-8000-0000000000b1';
    const B = '00000000-0000-4000-8000-0000000000b2';
    const isFinder = (call: FakeCall) => call.columns?.includes('alarms!inner') === true; // 알람 종류를 임베드하는 쿼리 = 최근 해제 · 확정 찾기

    // 알람마다 DISMISSED(해제 시각 오프셋 분) / 확정 여부. finder 쿼리는 모든 알람의 기록을, 알람별 쿼리는 그 알람의 기록을 줌
    function setupRecheck(alarms: { id: string; dismissedAt: number; confirmedAt?: number }[]) {
      const eventsOf = (id: string) => {
        const a = alarms.find((x) => x.id === id)!;
        return [
          { event_type: 'DISMISSED', event_at: eventAt(a.dismissedAt) },
          ...(a.confirmedAt == null ? [] : [{ event_type: 'WAKE_CONFIRMED', event_at: eventAt(a.confirmedAt), input_source: 'USAGE' }]),
        ];
      };
      mockRoutes['alarm_events:select'] = (call) => {
        if (isFinder(call)) {
          return {
            data: alarms.flatMap((a) => [
              { alarm_id: a.id, event_type: 'DISMISSED', event_at: eventAt(a.dismissedAt), alarms: { alarm_type: 'WAKE' } },
              ...(a.confirmedAt == null ? [] : [{ alarm_id: a.id, event_type: 'WAKE_CONFIRMED', event_at: eventAt(a.confirmedAt), alarms: { alarm_type: 'WAKE' } }]),
            ]),
          };
        }
        return { data: eventsOf(filterArgs(call, 'eq', 'alarm_id')?.[0] as string) };
      };
      mockRoutes['alarms:select'] = (call) => ({
        data: { alarm_id: filterArgs(call, 'eq', 'alarm_id')?.[0], alarm_type: 'WAKE', appointment_participants: { appointments: { title: '팀 주간회의', group_id: null, groups: null } } },
      });
      mockRoutes['alarm_events:upsert'] = () => undefined;
      mockRoutes['daily_records:select'] = () => ({ data: null });
      mockRoutes['daily_records:insert'] = () => undefined;
    }
    const usedBothHalves = [
      { startMillis: min(0.5), endMillis: min(1.5) },
      { startMillis: min(6), endMillis: min(7) },
    ];
    const upserts = () => callsTo('alarm_events', 'upsert').map((c) => c.payload as { alarm_id: string; event_type: string; event_at: string; input_source: string; client_event_id: string });

    it('앱을 안 연 사이에 10분이 지났고 조건을 채웠으면 확정(USAGE)을 기록 — 이미 확정한 알람은 건드리지 않음', async () => {
      setupRecheck([
        { id: A, dismissedAt: 0 },
        { id: B, dismissedAt: -120, confirmedAt: -118 },
      ]);
      mockNow = new Date(min(90)); // 해제 한 시간 반 뒤 앱을 엶
      mockCore.getUsageSpans.mockResolvedValue(usedBothHalves);
      expect(await real.recheckRecentWakes()).toEqual([A]);
      expect(upserts()).toEqual([
        { user_id: 'user-1', alarm_id: A, event_type: 'WAKE_CONFIRMED', event_at: eventAt(1.5), client_event_id: expect.stringMatching(UUID), input_source: 'USAGE' },
      ]);
      expect(mockCore.getUsageSpans).toHaveBeenCalledTimes(1); // 확정한 B는 사용 구간을 읽지도 않음
      expect(mockCore.getUsageSpans).toHaveBeenCalledWith(min(0), min(10));
      expect(callsTo('daily_records', 'insert')).toHaveLength(1);
    });

    it('찾는 조건: 최근 12시간의 기상 알람 해제 · 확정 기록, 먼저 폰에 남은 기록을 올림', async () => {
      setupRecheck([{ id: A, dismissedAt: 0 }]);
      mockNow = new Date(min(90));
      mockCore.getUsageSpans.mockResolvedValue([]);
      await real.recheckRecentWakes();
      const finder = mockCalls.find(isFinder)!;
      expect(filterArgs(finder, 'in', 'event_type')).toEqual([['DISMISSED', 'WAKE_CONFIRMED']]);
      expect(filterArgs(finder, 'eq', 'alarms.alarm_type')).toEqual(['WAKE']);
      expect(filterArgs(finder, 'eq', 'user_id')).toEqual(['user-1']);
      expect(filterArgs(finder, 'gte', 'event_at')).toEqual([new Date(min(90) - 12 * 60 * 60_000).toISOString()]);
      expect(mockUploadEvents).toHaveBeenCalled();
    });

    it('조건을 못 채웠거나 아직 10분이 안 됐으면 아무것도 쓰지 않음 (확인 알림은 H08에서, 놓침은 서버 배치)', async () => {
      setupRecheck([{ id: A, dismissedAt: 0 }]);
      mockNow = new Date(min(90));
      mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(0.2), endMillis: min(0.4) }]);
      expect(await real.recheckRecentWakes()).toEqual([]);
      mockNow = new Date(min(4)); // 해제 4분 뒤 — 관찰 중
      mockCore.getUsageSpans.mockResolvedValue(usedBothHalves);
      expect(await real.recheckRecentWakes()).toEqual([]);
      mockCore.hasUsageAccess.mockResolvedValue(false); // 사용 정보 접근이 없으면 판정 못 함
      mockNow = new Date(min(90));
      expect(await real.recheckRecentWakes()).toEqual([]);
      expect(upserts()).toEqual([]);
    });

    it('H08과 같은 확정 기록 — 번호가 같아서 H08에서 먼저 확정했거나 두 번 불려도 서버에는 한 줄만 남음', async () => {
      setupRecheck([{ id: A, dismissedAt: 0 }]);
      mockNow = new Date(min(90));
      mockCore.getUsageSpans.mockResolvedValue(usedBothHalves);
      await real.recheckRecentWakes();
      await real.getWakeCheck(A); // H08을 열어도 같은 판정 · 같은 번호
      await real.recheckRecentWakes();
      const ids = upserts().map((u) => u.client_event_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(1);
    });

    it('한 알람이 실패해도 다른 알람은 이어서 판정', async () => {
      setupRecheck([
        { id: A, dismissedAt: 0 },
        { id: B, dismissedAt: 5 },
      ]);
      mockNow = new Date(min(90));
      // 알람마다 해제 시각이 달라서, 어느 알람이든 해제 뒤 1분 · 6분쯤에 폰을 쓴 것으로
      mockCore.getUsageSpans.mockImplementation(async (from: number) => [
        { startMillis: from + 0.5 * 60_000, endMillis: from + 1.5 * 60_000 },
        { startMillis: from + 6 * 60_000, endMillis: from + 7 * 60_000 },
      ]);
      let n = 0;
      mockRoutes['alarm_events:upsert'] = () => (++n === 1 ? { error: { code: '', message: 'offline' } } : undefined);
      const confirmed = await real.recheckRecentWakes();
      expect(confirmed).toHaveLength(1); // 먼저 시도한 알람(가장 최근에 끈 B)이 실패하고 A는 확정
      expect(upserts()).toHaveLength(2);
    });

    it('찾는 쿼리가 실패하면 던짐 (부르는 훅이 다음 기회에 다시 — 개발 중에만 로그)', async () => {
      mockRoutes['alarm_events:select'] = () => ({ error: { code: '', message: 'offline' } });
      await expect(real.recheckRecentWakes()).rejects.toMatchObject({ message: 'offline' });
    });
  });
});

// H08 [먼저 깼어요] — 알람이 울리기 전 60분 안에 깬 날 (D61 · 7-20 · 7-38): 지금 시각으로 기상 확인(BUTTON), 그룹에는 바로 '일어났어요'
describe('먼저 깼어요 (H08)', () => {
  const ALARM = '00000000-0000-4000-8000-0000000000c1';
  const ALARM_AT = Date.parse(kst('08:50'));
  const before = (m: number) => {
    mockNow = new Date(ALARM_AT - m * 60_000);
  };
  function upcoming(events: { event_type: string; event_at: string; input_source?: string | null }[] = []) {
    mockRoutes['alarms:select'] = (call) =>
      call.single
        ? { data: { alarm_id: ALARM, alarm_type: 'WAKE', appointment_participants: { appointments: { title: '팀 주간회의', group_id: 'cap', groups: { group_name: '캡스톤팀' } } } } }
        : { data: [{ alarm_id: ALARM, scheduled_at: new Date(ALARM_AT).toISOString() }] };
    mockRoutes['alarm_events:select'] = () => ({ data: events });
    mockRoutes['alarm_events:upsert'] = () => undefined;
    mockRoutes['daily_records:select'] = () => ({ data: null });
    mockRoutes['daily_records:insert'] = () => undefined;
  }

  it('지금부터 60분 안에 울릴 켜진 기상 알람 하나 — 그 알람 시각', async () => {
    upcoming();
    before(30);
    expect(await real.getEarlyWake()).toEqual({ alarmId: ALARM, at: new Date(ALARM_AT) });
    const [query] = callsTo('alarms', 'select');
    expect(query.filters).toEqual([
      ['eq', 'user_id', 'user-1'],
      ['eq', 'alarm_type', 'WAKE'],
      ['eq', 'is_enabled', true],
      ['gt', 'scheduled_at', new Date(ALARM_AT - 30 * 60_000).toISOString()],
      ['lte', 'scheduled_at', new Date(ALARM_AT + 30 * 60_000).toISOString()],
      ['order', 'scheduled_at'],
      ['limit', 1],
    ]);
  });

  it('없거나, 이미 울렸거나 · 확인한 알람이면 null', async () => {
    before(30);
    mockRoutes['alarms:select'] = () => ({ data: [] });
    expect(await real.getEarlyWake()).toBeNull();
    upcoming([{ event_type: 'WAKE_CONFIRMED', event_at: new Date(ALARM_AT - 40 * 60_000).toISOString(), input_source: 'BUTTON' }]);
    expect(await real.getEarlyWake()).toBeNull();
    upcoming([{ event_type: 'TRIGGERED', event_at: new Date(ALARM_AT).toISOString() }]);
    expect(await real.getEarlyWake()).toBeNull();
  });

  it('누르면 지금 시각으로 WAKE_CONFIRMED(BUTTON) + 그날 기록 — 해제 기록 없이', async () => {
    upcoming();
    before(25);
    await real.confirmEarlyWake(ALARM);
    const [write] = callsTo('alarm_events', 'upsert');
    expect(write.payload).toMatchObject({ alarm_id: ALARM, event_type: 'WAKE_CONFIRMED', event_at: new Date(ALARM_AT - 25 * 60_000).toISOString(), input_source: 'BUTTON' });
    expect(callsTo('daily_records', 'insert')[0].payload).toMatchObject({ wake_confirmed_at: new Date(ALARM_AT - 25 * 60_000).toISOString(), wake_reported_at: null });
  });

  it('이미 확인했으면 다시 쓰지 않음', async () => {
    upcoming([{ event_type: 'WAKE_CONFIRMED', event_at: new Date(ALARM_AT - 40 * 60_000).toISOString(), input_source: 'BUTTON' }]);
    before(25);
    await real.confirmEarlyWake(ALARM);
    expect(callsTo('alarm_events', 'upsert')).toEqual([]);
  });
});
