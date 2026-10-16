import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EdgeError } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { formatTime } from '@/lib/format';

import { recallDetail } from '../detailCache';
import { resetAlarmMemory } from '../reset';
import { clearEdits, peekEdits } from '../editQueue';
import { forgetPlaces, lookupPlace } from '../places';
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
jest.mock('@/lib/alarmSync', () => ({
  applyCommit: (r: unknown) => mockApplyCommit(r),
  reconcile: (o?: { alarmIds?: string[] }) => mockReconcile(o),
  uploadEvents: () => mockUploadEvents(),
}));

const mockCore = {
  stop: jest.fn<() => Promise<void>>(),
  cancel: jest.fn<(id: string) => Promise<void>>(),
  list: jest.fn<() => Promise<unknown[]>>(),
  hasUsageAccess: jest.fn<() => Promise<boolean>>(),
  getUsageSpans: jest.fn<(from: number, to: number) => Promise<{ startMillis: number; endMillis: number }[]>>(),
  getPendingEvents: jest.fn<() => Promise<unknown[]>>(),
};
jest.mock('@capstone/alarm-core', () => ({
  stop: () => mockCore.stop(),
  cancel: (id: string) => mockCore.cancel(id),
  list: () => mockCore.list(),
  hasUsageAccess: () => mockCore.hasUsageAccess(),
  getUsageSpans: (from: number, to: number) => mockCore.getUsageSpans(from, to),
  getPendingEvents: () => mockCore.getPendingEvents(),
  makeUuid: () => 'uuid-fixed',
  toUseSpans: (spans: { startMillis: number; endMillis: number }[], dismissedAt: number) =>
    spans.map((s) => [(s.startMillis - dismissedAt) / 60_000, (s.endMillis - dismissedAt) / 60_000]),
}));

// 5월 22일 한국 시각
const kst = (hhmm: string, day = 22) => `2025-05-${String(day).padStart(2, '0')}T${hhmm}:00+09:00`;

const alarmRow = (id: string, type: string, hhmm: string, overrides: Record<string, unknown> = {}) => ({
  alarm_id: id,
  alarm_type: type,
  scheduled_at: kst(hhmm),
  intensity: 'NORMAL',
  voice_tone: 'NEUTRAL',
  sound_key: 'theme_default',
  is_enabled: true,
  time_source: 'AUTO',
  intensity_source: 'AUTO',
  ...overrides,
});
const meetingAlarms = () => [alarmRow('a-wake', 'WAKE', '08:00'), alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-dep', 'DEPARTURE', '09:00'), alarmRow('a-arrive', 'ARRIVE', '09:50')];

const participantRow = (overrides: Record<string, unknown> = {}, appointment: Record<string, unknown> = {}, alarms: unknown[] = meetingAlarms()) => ({
  participant_id: 'p-1',
  origin_name: '집',
  transport_type: 'TRANSIT',
  est_travel_minutes: 50,
  travel_source: 'API',
  prepare_minutes: 60,
  buffer_minutes: 10,
  appointments: { appointment_id: 'appt-1', title: '팀 주간회의', appointment_at: kst('10:00'), dest_name: '세종대학교', importance: 'NORMAL', recurrence_rule: null, groups: { group_name: '캡스톤팀' }, ...appointment },
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
    mockRoutes['todos:select'] = () => ({ data: [{ appointment_id: 'appt-1', title: '노트북' }] });
    mockRoutes['alarms:select'] = () => ({
      data: [{ ...alarmRow('s-1', 'WAKE', '07:00'), recurrence_rule: null }],
    });
    const list = await real.listAppointments();

    expect(list.map((a) => `${a.title} ${formatTime(a.at)}`)).toEqual(['알람 오전 7:00', '팀 주간회의 오전 10:00']); // 치과 예약은 알람이 없어 H02에 없음
    expect(list[1].items).toEqual(['노트북']);
    expect(list[0].standalone).toBe(true);

    const [read] = callsTo('appointment_participants', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual(['2025-04-21T15:00:00.000Z']); // 5월 22일 0시(한국) − 30일
    const [standalone] = callsTo('alarms', 'select');
    expect(filterArgs(standalone, 'is', 'participant_id')).toEqual([null]);
    expect(filterArgs(standalone, 'is', 'routine_id')).toEqual([null]);
    expect(filterArgs(standalone, 'eq', 'alarm_type')).toEqual(['WAKE']);
  });

  it('getDaySchedule: 그날 0시 ~ 다음 날 0시, 알람 없는 일정도 한 줄', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        { participant_id: 'p-2', appointments: { appointment_id: 'appt-2', title: '치과 예약', appointment_at: kst('15:30'), dest_name: '동네 치과', importance: 'LOW' }, alarms: [] },
        { participant_id: 'p-1', appointments: { appointment_id: 'appt-1', title: '팀 주간회의', appointment_at: kst('10:00'), dest_name: '세종대학교', importance: 'NORMAL' }, alarms: [{ alarm_id: 'a', alarm_type: 'WAKE' }] },
      ],
    });
    const items = await real.getDaySchedule(new Date(kst('00:00')));
    expect(items.map((i) => `${i.title} ${i.hasAlarm}`)).toEqual(['팀 주간회의 true', '치과 예약 false']);
    const [read] = callsTo('appointment_participants', 'select');
    expect(filterArgs(read, 'gte', 'appointments.appointment_at')).toEqual([new Date(kst('00:00')).toISOString()]);
    expect(filterArgs(read, 'lt', 'appointments.appointment_at')).toEqual([new Date(kst('00:00', 23)).toISOString()]);
  });

  it('getAppointment: 저장된 값 + 최근 4주 지각 횟수로 강도 자동 값, 읽은 값은 미리 보기용으로 기억', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 2 } : { data: participantRow() });
    const detail = await real.getAppointment('appt-1');
    expect(detail).toMatchObject({ id: 'appt-1', title: '팀 주간회의', level: 1 });
    expect(detail?.intensity).toMatchObject({ lateCount: 2, latePoint: 1, auto: 2 }); // 보통(중요) 1점 + 지각 2번 1점
    expect(recallDetail('appt-1')).toBe(detail);
    const count = mockCalls.find(isCount)!;
    expect(filterArgs(count, 'eq', 'is_late')).toEqual([true]);
    expect(filterArgs(count, 'gte', 'arrived_at')).toEqual(['2025-04-23T22:55:00.000Z']); // 지금 − 28일
  });

  it('getAppointment: 알람이 없는 일정 · 내 것이 아닌(없는) 일정 · 일정 없는 알람 id는 null', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow({}, {}, []) });
    expect(await real.getAppointment('appt-1')).toBeNull();
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: null });
    expect(await real.getAppointment('standalone-alarm-id')).toBeNull();
  });

  it('getNextAlarm: 가장 이른 켜진 알람이 일정 없는 알람이면 제목 "알람"으로', async () => {
    mockRoutes['alarms:select'] = (call) =>
      call.columns === 'alarm_id, participant_id'
        ? { data: { alarm_id: 's-1', participant_id: null } }
        : { data: { ...alarmRow('s-1', 'WAKE', '08:10'), recurrence_rule: null } };
    const next = await real.getNextAlarm();
    expect(next?.appointment.title).toBe('알람');
    expect(next && formatTime(next.alarm.at)).toBe('오전 8:10');
    const [first] = callsTo('alarms', 'select');
    expect(filterArgs(first, 'is', 'routine_id')).toEqual([null]);
    expect(filterArgs(first, 'in', 'alarm_type')).toEqual([['WAKE', 'PREPARE', 'DEPARTURE']]);
  });

  it('getNextAlarm: 약속 알람이면 그 약속을 읽어 다음 알람을 고름 · 알람이 없으면 null', async () => {
    mockRoutes['alarms:select'] = () => ({ data: { alarm_id: 'a-wake', participant_id: 'p-1' } });
    mockRoutes['appointment_participants:select'] = () => ({ data: participantRow() });
    const next = await real.getNextAlarm();
    expect(next?.appointment.title).toBe('팀 주간회의');
    expect(next?.alarm.kind).toBe('WAKE');
    mockRoutes['alarms:select'] = () => ({ data: null });
    expect(await real.getNextAlarm()).toBeNull();
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

describe('켜기 · 끄기 · 강도 (DB 직접 → 그 알람만 폰에 맞춤)', () => {
  it('setAppointmentEnabled: 약속의 알람 전부(도착 목표 포함)를 바꾸고 그 알람만 reconcile', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-wake' }, { alarm_id: 'a-prep' }, { alarm_id: 'a-dep' }, { alarm_id: 'a-arrive' }] });
    await real.setAppointmentEnabled('appt-1', false);
    const [update] = callsTo('alarms', 'update');
    expect(update.payload).toEqual({ is_enabled: false });
    expect(filterArgs(update, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(filterArgs(update, 'eq', 'user_id')).toEqual(['user-1']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['a-wake', 'a-prep', 'a-dep', 'a-arrive'] });
  });

  it('setAppointmentEnabled: 약속이 아니면 일정 없는 알람 id로 (참여 조건 · 루틴 없는 내 알람만)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: null });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 's-1' }] });
    await real.setAppointmentEnabled('s-1', true);
    const [update] = callsTo('alarms', 'update');
    expect(filterArgs(update, 'eq', 'alarm_id')).toEqual(['s-1']);
    expect(filterArgs(update, 'is', 'participant_id')).toEqual([null]);
    expect(filterArgs(update, 'is', 'routine_id')).toEqual([null]);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['s-1'] });
  });

  it('setAppointmentEnabled: 없는 알람이면 이유를 UserError로, DB 오류는 그대로', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: null });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    await expect(real.setAppointmentEnabled('gone', false)).rejects.toBeInstanceOf(UserError);
    mockRoutes['alarms:update'] = () => ({ error: { code: '', message: 'offline' } });
    await expect(real.setAppointmentEnabled('gone', false)).rejects.toMatchObject({ message: 'offline' });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('켤 때는 아직 안 지난 알람만 켬 (지난 기상 알람을 켜면 서버 배치가 울린 적 없는 알람을 기상 미확인으로 기록함) — 끌 때는 전부', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-dep' }] });
    await real.setAppointmentEnabled('appt-1', true);
    expect(filterArgs(callsTo('alarms', 'update')[0], 'gt', 'scheduled_at')).toEqual(['2025-05-21T22:55:00.000Z']);
    await real.setAppointmentEnabled('appt-1', false);
    expect(filterArgs(callsTo('alarms', 'update')[1], 'gt', 'scheduled_at')).toBeUndefined();
    mockCalls.length = 0;
    await real.setAlarmEnabled('appt-1', 'WAKE', true);
    expect(filterArgs(callsTo('alarms', 'update')[0], 'gt', 'scheduled_at')).toEqual(['2025-05-21T22:55:00.000Z']);
  });

  it('켤 알람이 모두 지났으면 이유를 UserError로 (DB는 안 바뀜)', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    await expect(real.setAppointmentEnabled('appt-1', true)).rejects.toThrow('이미 지난');
    await expect(real.setAlarmEnabled('appt-1', 'WAKE', true)).rejects.toThrow('이미 지난');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('폰에 걸지 못한 알람이 있으면(정확한 알람 권한 없음 등) UserError — DB에는 이미 씀', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-wake' }] });
    mockReconcile.mockResolvedValue({ failed: [{ alarmId: 'a-wake', error: '정확한 알람 권한 없음' }] });
    await expect(real.setAppointmentEnabled('appt-1', true)).rejects.toBeInstanceOf(UserError);
    expect(callsTo('alarms', 'update')).toHaveLength(1);
  });

  it('setAlarmEnabled: 그 종류만 바꾸고, 울리는 알람이 모두 꺼지면 도착 목표도 끔', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ data: { participant_id: 'p-1' } });
    mockRoutes['alarms:update'] = (call) => (call.payload && 'is_enabled' in (call.payload as object) && filterArgs(call, 'eq', 'alarm_type') ? { data: [{ alarm_id: 'a-dep' }] } : undefined);
    // 이미 기상 · 준비는 꺼져 있고 출발을 끔 -> 모두 꺼짐
    mockRoutes['alarms:select'] = () => ({
      data: [
        { alarm_id: 'a-wake', alarm_type: 'WAKE', is_enabled: false },
        { alarm_id: 'a-prep', alarm_type: 'PREPARE', is_enabled: false },
        { alarm_id: 'a-dep', alarm_type: 'DEPARTURE', is_enabled: false },
        { alarm_id: 'a-arrive', alarm_type: 'ARRIVE', is_enabled: true },
      ],
    });
    await real.setAlarmEnabled('appt-1', 'DEPARTURE', false);
    const updates = callsTo('alarms', 'update');
    expect(updates[0].payload).toEqual({ is_enabled: false });
    expect(filterArgs(updates[0], 'eq', 'alarm_type')).toEqual(['DEPARTURE']);
    expect(updates[1].payload).toEqual({ is_enabled: false });
    expect(filterArgs(updates[1], 'eq', 'alarm_id')).toEqual(['a-arrive']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['a-dep', 'a-arrive'] });
  });

  it('setIntensity: 한 칸을 직접 고르면 세 칸 값을 약속의 모든 알람에 쓰고 intensity_source = MANUAL', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-wake' }, { alarm_id: 'a-prep' }] });
    await real.setIntensity('appt-1', 'sound', 2);
    const [update] = callsTo('alarms', 'update');
    expect(update.payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_urgent', intensity_source: 'MANUAL' });
    expect(filterArgs(update, 'eq', 'participant_id')).toEqual(['p-1']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['a-wake', 'a-prep'] });
  });

  it('setIntensity: 다른 칸의 직접 값은 이어 가고, 마지막 직접 값을 자동으로 되돌리면 AUTO', async () => {
    const manualAlarms = [alarmRow('a-wake', 'WAKE', '08:00', { intensity_source: 'MANUAL', sound_key: 'theme_urgent' })];
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow({}, {}, manualAlarms) });
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-wake' }] });
    await real.setIntensity('appt-1', 'vibration', 0); // 배경음 강 · 진동 약
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'SOFT', voice_tone: 'NEUTRAL', sound_key: 'theme_urgent', intensity_source: 'MANUAL' });
    mockCalls.length = 0;
    await real.setIntensity('appt-1', 'sound', null); // 남은 직접 값이 없음
    expect(callsTo('alarms', 'update')[0].payload).toEqual({ intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', intensity_source: 'AUTO' });
  });

  it('쓰기 뒤 H03의 기억해 둔 저장 값은 지움', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    await real.getAppointment('appt-1');
    expect(recallDetail('appt-1')).toBeDefined();
    mockRoutes['alarms:update'] = () => ({ data: [{ alarm_id: 'a-wake' }] });
    await real.setIntensity('appt-1', 'voice', 2);
    expect(recallDetail('appt-1')).toBeUndefined();
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
    { alarm_id: 'n-wake', alarm_type: 'WAKE', scheduled_at: kst('08:00', 23), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null },
    { alarm_id: 'n-arrive', alarm_type: 'ARRIVE', scheduled_at: kst('09:50', 23), is_enabled: true, intensity: 'NORMAL', voice_tone: 'NEUTRAL', sound_key: 'theme_default', time_source: 'AUTO', intensity_source: 'AUTO', recurrence_rule: null },
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

  it('검색어가 없으면 최근에 쓴 곳(최근 약속의 도착지 · 출발지, "집" 제외) — 서버 함수를 부르지 않음', async () => {
    mockRoutes['appointment_participants:select'] = () => ({
      data: [
        { origin_name: '집', origin_lat: 37.5, origin_lng: 127.0, appointments: { dest_name: '학교 도서관', dest_lat: 37.1, dest_lng: 127.1, appointment_at: kst('09:00', 20) } },
        { origin_name: '세종대학교', origin_lat: 37.55, origin_lng: 127.07, appointments: { dest_name: '강남역', dest_lat: 37.49, dest_lng: 127.03, appointment_at: kst('18:00', 21) } },
      ],
    });
    const places = await real.listPlaces();
    expect(mockCallEdge).not.toHaveBeenCalled();
    expect(places.map((p) => p.name)).toEqual(['강남역', '학교 도서관', '세종대학교']); // 최근 약속의 도착지 먼저
    expect(lookupPlace('강남역')).toMatchObject({ lat: 37.49 });
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
    return (await real.getAppointment('appt-1'))!;
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
    const preview = await real.previewAlarms('appt-1', { ...detail.edits, travelMinutes: 40 });
    expect(mockCalls).toEqual([]);
    expect(mockCallEdge.mock.calls[0][1]).toMatchObject({ appointment_id: 'appt-1', participant: { est_travel_minutes: 40, travel_source: 'MANUAL' } });
    expect(preview).toMatchObject({ travelMinutes: 40, travelSource: '직접 입력', autoTravelMinutes: 55 });
  });

  it('previewAlarms: 출발 시각까지 지난 일정은 서버가 오류로 줘도 계산 결과로 미리 보기를 보여 줌', async () => {
    const detail = await loaded();
    mockCallEdge.mockRejectedValue(new EdgeError('UNPROCESSABLE', { details: { reason: 'DEPARTURE_PASSED', suggestion: suggestion({ check: { ok: false, reason: 'DEPARTURE_PASSED' } }) } }));
    await expect(real.previewAlarms('appt-1', detail.edits)).resolves.toMatchObject({ travelMinutes: 50 });
    mockCallEdge.mockRejectedValue(new EdgeError('NETWORK'));
    await expect(real.previewAlarms('appt-1', detail.edits)).rejects.toBeInstanceOf(UserError);
  });

  it('saveAlarmSettings: 종류만 바꾸면 계산 없이 저장 — enabled · levels · 고친 값 기록(alarm_enabled)', async () => {
    const detail = await loaded();
    mockCalls.length = 0;
    mockCallEdge.mockResolvedValue(
      commitResponse({
        alarms: ['WAKE', 'PREPARE', 'DEPARTURE'].map((t) => ({ ...commitResponse().alarms[0], alarm_id: t, alarm_type: t, is_enabled: t !== 'WAKE' })),
      }),
    );
    mockRoutes['alarms:select'] = () => ({ data: [{ alarm_id: 'a-wake', alarm_type: 'WAKE', is_enabled: false }, { alarm_id: 'a-arrive', alarm_type: 'ARRIVE', is_enabled: true }] });
    mockRoutes['alarms:update'] = () => ({ data: [] });
    const result = await real.saveAlarmSettings('appt-1', { ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } });

    expect(mockCallEdge).toHaveBeenCalledTimes(1);
    const [name, body] = mockCallEdge.mock.calls[0];
    expect(name).toBe('alarm-commit');
    expect(body).toMatchObject({
      appointment_id: 'appt-1',
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
    await real.saveAlarmSettings('appt-1', { ...same(detail), travelMinutes: 40 });
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
    await expect(real.saveAlarmSettings('appt-1', { ...same(detail), times: { WAKE: new Date(kst('09:30')) } })).rejects.toThrow('빠를 수 없어요');
    expect(mockCallEdge).toHaveBeenCalledTimes(1);

    mockCallEdge.mockResolvedValueOnce(suggestion({ alarms: [], travel: { minutes: null, source: null, manual_required: true, needs_confirmation: true, note: null, auto_minutes: null } }));
    await expect(real.saveAlarmSettings('appt-1', { ...same(detail), origin: '모르는 곳' })).rejects.toThrow('직접 입력');
  });

  it('saveAlarmSettings: 종류를 모두 껐으면 turnedOff, 껐던 것을 다시 켜면 turnedOn', async () => {
    const detail = await loaded();
    const allOff = commitResponse({ alarms: ['WAKE', 'PREPARE', 'DEPARTURE'].map((t) => ({ ...commitResponse().alarms[0], alarm_id: t, alarm_type: t, is_enabled: false })) });
    mockCallEdge.mockResolvedValueOnce(allOff);
    mockRoutes['alarms:select'] = () => ({ data: [] });
    expect(await real.saveAlarmSettings('appt-1', { ...same(detail), kinds: { WAKE: false, PREPARE: false, DEPARTURE: false } })).toEqual({ turnedOff: true, turnedOn: false });

    mockRoutes['appointment_participants:select'] = (call) =>
      isCount(call) ? { count: 0 } : { data: participantRow({}, {}, meetingAlarms().map((a) => ({ ...a, is_enabled: false }))) };
    const offDetail = (await real.getAppointment('appt-1'))!;
    mockCallEdge.mockResolvedValueOnce(commitResponse());
    expect(await real.saveAlarmSettings('appt-1', { ...same(offDetail), kinds: { WAKE: true, PREPARE: false, DEPARTURE: false } })).toEqual({ turnedOff: false, turnedOn: true });
  });

  it('saveAlarmSettings: 저장은 됐는데 폰에 못 걸었으면 UserError (같은 저장을 다시 해도 같은 상태가 됨)', async () => {
    const detail = await loaded();
    mockCallEdge.mockResolvedValue(commitResponse());
    mockRoutes['alarms:select'] = () => ({ data: [] });
    mockApplyCommit.mockResolvedValue({ failed: [{ alarmId: 'n-wake', error: '정확한 알람 권한 없음' }] });
    await expect(real.saveAlarmSettings('appt-1', { ...same(detail), kinds: { WAKE: false, PREPARE: true, DEPARTURE: true } })).rejects.toBeInstanceOf(UserError);
  });

  it('saveAlarmSettings: 저장과 따로 쌓인 고친 값 기록(recordEdit)을 같은 일정의 저장에 실어 보내고, 성공하면 비움', async () => {
    const detail = await loaded();
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: 'appt-1', alarmType: 'WAKE', autoValue: new Date(kst('08:00')), editedValue: new Date(kst('07:50')) });
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: 'other', alarmType: 'WAKE', autoValue: 1, editedValue: 2 });
    mockRoutes['alarms:select'] = () => ({ data: [] });

    mockCallEdge.mockRejectedValueOnce(new EdgeError('NETWORK'));
    await expect(real.saveAlarmSettings('appt-1', same(detail))).rejects.toBeInstanceOf(UserError);
    expect(peekEdits('appt-1')).toHaveLength(1); // 저장이 실패하면 큐에 남음

    mockCallEdge.mockResolvedValueOnce(commitResponse());
    await real.saveAlarmSettings('appt-1', same(detail));
    expect((mockCallEdge.mock.calls.at(-1)?.[1] as { edits: unknown }).edits).toEqual([
      { screen: 'S01', field: 'scheduled_at', alarm_type: 'WAKE', auto_value: new Date(kst('08:00')).toISOString(), edited_value: new Date(kst('07:50')).toISOString() },
    ]);
    expect(peekEdits('appt-1')).toEqual([]);
    expect(peekEdits('other')).toHaveLength(1); // 다른 일정의 기록은 그 일정의 저장을 기다림
  });
});

describe('로그아웃 · 계정 전환 때 메모리 비우기 (resetAlarmMemory)', () => {
  it('읽어 둔 알람 설정 · 쌓인 고친 값 기록 · 기억해 둔 장소 좌표를 모두 비움', async () => {
    mockRoutes['appointment_participants:select'] = (call) => (isCount(call) ? { count: 0 } : { data: participantRow() });
    await real.getAppointment('appt-1');
    await real.recordEdit({ screen: 'S01', field: 'scheduled_at', appointmentId: 'appt-1', autoValue: 1, editedValue: 2 });
    mockCallEdge.mockResolvedValue({ places: [{ id: '1', name: '세종대학교', lat: 37.55, lng: 127.07 }] });
    await real.listPlaces('세종');
    resetAlarmMemory();
    expect(recallDetail('appt-1')).toBeUndefined();
    expect(peekEdits('appt-1')).toEqual([]);
    expect(lookupPlace('세종대학교')).toBeUndefined();
  });
});

describe('일정 없는 알람 (D46)', () => {
  const standaloneResponse = () => ({
    alarm_id: 's-1',
    alarms: [{ alarm_id: 's-1', alarm_type: 'WAKE', scheduled_at: kst('07:00', 23), is_enabled: true, intensity: 'STRONG', voice_tone: 'DIRECT', sound_key: 'theme_urgent', time_source: 'MANUAL', intensity_source: 'MANUAL', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' }],
    ring_packages: [{ alarmId: 's-1' }],
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
    expect(saved).toMatchObject({ id: 's-1', title: '알람', standalone: true, repeatLabel: '매주 월요일', level: 2 });
  });

  it('고치기: 알람 id만 있으면 시각 없이 강도 · 켜기만 보냄, 만들기인데 시각이 없으면 UserError', async () => {
    mockCallEdge.mockResolvedValue(standaloneResponse());
    await real.saveStandaloneAlarm({ alarmId: 's-1', level: 0 });
    expect((mockCallEdge.mock.calls[0][1] as { alarm: unknown }).alarm).toEqual({ alarm_id: 's-1', levels: { sound: 0, voice: 0, vibration: 0 } });
    await expect(real.saveStandaloneAlarm({ level: 1 })).rejects.toBeInstanceOf(UserError);
  });
});

describe('고친 값 기록 읽기 (listEditLogs)', () => {
  it('내 기록을 오래된 순으로 화면 모양으로 돌려줌', async () => {
    mockRoutes['user_edit_logs:select'] = () => ({
      data: [
        { created_at: '2025-05-22T02:00:00+00:00', screen: 'H03', field: 'buffer_minutes', appointment_id: 'appt-1', alarm_id: null, alarm_type: null, auto_value: 10, edited_value: 15 },
        { created_at: '2025-05-22T01:00:00+00:00', screen: 'H05', field: 'scheduled_at', appointment_id: 'appt-1', alarm_id: 'a-wake', alarm_type: 'WAKE', auto_value: '2025-05-21T23:00:00Z', edited_value: '2025-05-21T22:45:00Z' },
      ],
    });
    const logs = await real.listEditLogs();
    expect(logs.map((l) => l.field)).toEqual(['scheduled_at', 'buffer_minutes']); // 최근순으로 읽은 것을 뒤집어 오래된 순
    expect(logs[0]).toMatchObject({ screen: 'H05', alarmId: 'a-wake', alarmType: 'WAKE' });
    const [read] = callsTo('user_edit_logs', 'select');
    expect(filterArgs(read, 'eq', 'user_id')).toEqual(['user-1']);
    expect(mockCalls.some((c) => c.table === 'user_edit_logs' && c.op !== 'select')).toBe(false); // 따로 insert하지 않음
  });
});

// ---------------------------------------------------------------------------
// 울림 · 기상 확인
// ---------------------------------------------------------------------------

describe('울림 (H07) — 알람 코어로 잇거나 실데이터에서는 열 알람이 없음', () => {
  it('getRing은 늘 null (울림은 알람 코어 화면), 해제는 알람 코어 stop', async () => {
    expect(await real.getRing()).toBeNull();
    await real.dismissRing();
    expect(mockCore.stop).toHaveBeenCalledTimes(1);
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
});

describe('기상 확인 (H08)', () => {
  const DISMISSED = Date.parse(kst('08:00'));
  const min = (m: number) => DISMISSED + m * 60_000;
  const eventAt = (m: number) => new Date(min(m)).toISOString();

  // 알람 한 줄 + 그 알람의 DISMISSED / WAKE_CONFIRMED 기록
  function setup(events: { event_type: string; event_at: string; input_source?: string | null }[], opts: { appointment?: Record<string, unknown> | null } = {}) {
    mockRoutes['alarms:select'] = () => ({
      data: { alarm_id: 'a-wake', alarm_type: 'WAKE', appointment_participants: { appointments: opts.appointment === undefined ? { title: '팀 주간회의', group_id: 'cap', groups: { group_name: '캡스톤팀' } } : opts.appointment } },
    });
    mockRoutes['alarm_events:select'] = () => ({ data: events });
    mockRoutes['alarm_events:insert'] = () => undefined;
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
    expect(await real.getWakeCheck('a-wake')).toBeNull();
    expect(mockUploadEvents).toHaveBeenCalledTimes(1);
  });

  it('기상 알람이 아니거나 없는 알람이면 null', async () => {
    mockRoutes['alarms:select'] = () => ({ data: { alarm_id: 'a-dep', alarm_type: 'DEPARTURE', appointment_participants: null } });
    mockRoutes['alarm_events:select'] = () => ({ data: [] });
    expect(await real.getWakeCheck('a-dep')).toBeNull();
    mockRoutes['alarms:select'] = () => ({ data: null });
    expect(await real.getWakeCheck('gone')).toBeNull();
  });

  it('해제 뒤 10분 안: 관찰 중 — 지금까지의 사용 시간, 그룹 일정이면 그룹 이름', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(4);
    mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(0.5), endMillis: min(1.5) }]);
    const check = await real.getWakeCheck('a-wake');
    expect(check).toMatchObject({ alarmId: 'a-wake', appointmentTitle: '팀 주간회의', groupId: 'cap', groupName: '캡스톤팀', phase: 'observing', usage: 1, recent: 0, thetaMinutes: 1, confirmed: null });
    expect(check?.dismissedAt.getTime()).toBe(min(0));
    expect(mockCore.getUsageSpans).toHaveBeenCalledWith(min(0), min(4)); // 지금까지만 읽음
    expect(callsTo('alarm_events', 'insert')).toEqual([]);
  });

  it('10분이 끝났고 조건을 채웠으면 자동 확정 — event_at은 θ를 넘은 시각, 입력 출처 USAGE, 그날 기록에도 남김', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    mockCore.getUsageSpans.mockResolvedValue([
      { startMillis: min(0.5), endMillis: min(1.5) },
      { startMillis: min(6), endMillis: min(7) },
    ]);
    const check = await real.getWakeCheck('a-wake');
    expect(check?.confirmed).toEqual({ at: new Date(min(1.5)), how: 'auto' });
    expect(mockCore.getUsageSpans).toHaveBeenCalledWith(min(0), min(10));
    expect(callsTo('alarm_events', 'insert')[0].payload).toEqual({
      user_id: 'user-1',
      alarm_id: 'a-wake',
      event_type: 'WAKE_CONFIRMED',
      event_at: new Date(min(1.5)).toISOString(),
      client_event_id: 'uuid-fixed',
      input_source: 'USAGE',
    });
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
    expect(await real.getWakeCheck('a-wake')).toMatchObject({ phase: 'prompt', usage: 0.2, confirmed: null });
    mockCore.hasUsageAccess.mockResolvedValue(false);
    at(1);
    expect(await real.getWakeCheck('a-wake')).toMatchObject({ phase: 'prompt', usage: 0, recent: 0 });
    mockCore.hasUsageAccess.mockResolvedValue(true);
    mockCore.getUsageSpans.mockRejectedValue(new Error('안드로이드 9 미만'));
    expect(await real.getWakeCheck('a-wake')).toMatchObject({ phase: 'prompt' });
    expect(callsTo('alarm_events', 'insert')).toEqual([]);
  });

  it('올리지 못한 해제 기록(폰에 남은 것)도 해제 시각으로 씀', async () => {
    setup([]);
    at(2);
    mockCore.getPendingEvents.mockResolvedValue([{ clientEventId: 'e1', alarmId: 'a-wake', alarmType: 'WAKE', eventType: 'DISMISSED', at: min(0), sequenceNo: 1, inputSource: 'BUTTON' }]);
    expect((await real.getWakeCheck('a-wake'))?.dismissedAt.getTime()).toBe(min(0));
  });

  it('이미 확정한 알람은 처음 판정 그대로 — 다시 쓰지 않음', async () => {
    setup([
      { event_type: 'DISMISSED', event_at: eventAt(0) },
      { event_type: 'WAKE_CONFIRMED', event_at: eventAt(2), input_source: 'BUTTON' },
    ]);
    at(60);
    const check = await real.getWakeCheck('a-wake');
    expect(check?.confirmed).toEqual({ at: new Date(min(2)), how: 'self' });
    await real.confirmWake('a-wake', 'self');
    expect(callsTo('alarm_events', 'insert')).toEqual([]);
  });

  it('confirmWake(self): 지금 시각으로 WAKE_CONFIRMED(BUTTON) + 그날 기록, 두 번 눌러도(동시) 한 번만', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(12);
    await Promise.all([real.confirmWake('a-wake', 'self'), real.confirmWake('a-wake', 'self')]);
    const inserts = callsTo('alarm_events', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({ event_type: 'WAKE_CONFIRMED', event_at: new Date(min(12)).toISOString(), input_source: 'BUTTON' });
    expect(callsTo('daily_records', 'insert')).toHaveLength(1);
  });

  it('그날 기록이 이미 있으면 빈 칸(기상 확인 시각)만 채우고 있던 값은 덮지 않음', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: null, wake_reported_at: '2025-05-21T22:59:00Z' } });
    mockRoutes['daily_records:update'] = () => undefined;
    at(12);
    await real.confirmWake('a-wake', 'self');
    expect(callsTo('daily_records', 'insert')).toEqual([]);
    expect(callsTo('daily_records', 'update')[0].payload).toEqual({ wake_confirmed_at: new Date(min(12)).toISOString() });

    mockCalls.length = 0;
    mockRoutes['alarm_events:select'] = () => ({ data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    mockRoutes['daily_records:select'] = () => ({ data: { record_id: 'r1', wake_confirmed_at: '2025-05-21T23:01:00Z', wake_reported_at: '2025-05-21T22:59:00Z' } });
    await real.confirmWake('a-wake', 'self');
    expect(callsTo('daily_records', 'update')).toEqual([]); // 처음 확인 시각을 그대로
  });

  it('기록 중 같은 날 행이 그 사이 생겨 insert가 겹치면(23505) 빈 칸만 채움', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['daily_records:insert'] = () => ({ error: { code: '23505', message: 'duplicate key' } });
    mockRoutes['daily_records:update'] = () => undefined;
    at(12);
    await real.confirmWake('a-wake', 'self');
    expect(callsTo('daily_records', 'update')).toHaveLength(1);
  });

  it('confirmWake(auto): θ를 넘은 시각으로 기록 (못 구하면 지금)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    at(15);
    mockCore.getUsageSpans.mockResolvedValue([{ startMillis: min(2), endMillis: min(3.5) }]);
    await real.confirmWake('a-wake', 'auto');
    expect(callsTo('alarm_events', 'insert')[0].payload).toMatchObject({ event_at: new Date(min(3)).toISOString(), input_source: 'USAGE' });
  });

  it('기록 쓰기가 실패하면 던짐 (화면이 다시 누를 수 있게 풀어 줌)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:insert'] = () => ({ error: { code: '', message: 'offline' } });
    at(12);
    await expect(real.confirmWake('a-wake', 'self')).rejects.toMatchObject({ message: 'offline' });
    expect(callsTo('daily_records', 'insert')).toEqual([]); // 이벤트가 먼저, 실패하면 그날 기록도 안 씀
  });

  it('getWakeCheck: 알람 id가 없으면 가장 최근에 끈 기상 알람 (12시간 안)', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:select'] = (call) => (call.columns?.includes('alarms!inner') ? { data: [{ alarm_id: 'a-wake', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] } : { data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    at(3);
    expect((await real.getWakeCheck())?.alarmId).toBe('a-wake');
    const finder = mockCalls.find((c) => c.columns?.includes('alarms!inner'))!;
    expect(filterArgs(finder, 'eq', 'event_type')).toEqual(['DISMISSED']);
    expect(filterArgs(finder, 'eq', 'alarms.alarm_type')).toEqual(['WAKE']);
    expect(filterArgs(finder, 'gte', 'event_at')).toEqual([new Date(min(3) - 12 * 60 * 60_000).toISOString()]);
  });

  it('getWakeInProgress: 해제 뒤 40분(관찰 10 + 응답 여유 30) 안이고 확정 전일 때만', async () => {
    setup([{ event_type: 'DISMISSED', event_at: eventAt(0) }]);
    mockRoutes['alarm_events:select'] = (call) => (call.columns?.includes('alarms!inner') ? { data: [{ alarm_id: 'a-wake', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] } : { data: [{ event_type: 'DISMISSED', event_at: eventAt(0) }] });
    at(20);
    mockCore.getUsageSpans.mockResolvedValue([]);
    expect(await real.getWakeInProgress()).toMatchObject({ alarmId: 'a-wake', phase: 'prompt' });
    const finder = mockCalls.find((c) => c.columns?.includes('alarms!inner'))!;
    expect(filterArgs(finder, 'gte', 'event_at')).toEqual([new Date(min(20) - 40 * 60_000).toISOString()]);

    // 확정한 뒤에는 없음
    mockRoutes['alarm_events:select'] = (call) =>
      call.columns?.includes('alarms!inner')
        ? { data: [{ alarm_id: 'a-wake', event_at: eventAt(0), alarms: { alarm_type: 'WAKE' } }] }
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

  it('확인 알림 · 놓침은 앱이 기록하지 않음 (놓침 MISSED는 서버 배치)', async () => {
    await real.promptWake();
    await real.missWake();
    expect(mockCalls).toEqual([]);
  });
});
