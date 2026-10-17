import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import { decideWrite, judgeArrival, LATE_AFTER_MINUTES, mayWritePrepare, prepareMinutesOf, recordParticipantTimes, type RecordTimesInput } from '../participantTimes';

// 규칙(순수 함수)과 DB에 쓰는 순서(가짜 클라이언트)를 나눠 확인 — 진짜 PostgREST · RLS는 실제 Supabase에서
let mockRoutes: Record<string, (call: FakeCall) => FakeResult | undefined> = {};
const mockCalls: FakeCall[] = [];
jest.mock('@/lib/supabase', () => {
  const { fakeBuilder: build } = jest.requireActual<typeof import('../testkit/fakeSupabase')>('../testkit/fakeSupabase');
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

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();
const APPOINTMENT = at('10:00');
const min = (m: number) => APPOINTMENT + m * 60_000;

describe('지각 판정 (judgeArrival, D · #41)', () => {
  it('약속 시각 + 5분을 넘으면 지각, 정확히 5분은 아님 (응답으로 받은 도착)', () => {
    expect(LATE_AFTER_MINUTES).toBe(5);
    expect(judgeArrival(min(5), APPOINTMENT)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(judgeArrival(min(5) + 1000, APPOINTMENT)).toEqual({ isLate: true, lateMinutes: 5 });
    expect(judgeArrival(min(12), APPOINTMENT)).toEqual({ isLate: true, lateMinutes: 12 });
  });

  it('응답(원탭 · 직접 입력)은 −2~+5분이어도 일찍 도착해도 지각이 아님 — 사용자 말 그대로', () => {
    for (const source of ['BUTTON', 'MANUAL'] as const) {
      expect(judgeArrival(min(-2), APPOINTMENT, source)).toEqual({ isLate: false, lateMinutes: 0 });
      expect(judgeArrival(min(3), APPOINTMENT, source)).toEqual({ isLate: false, lateMinutes: 0 });
      expect(judgeArrival(min(-30), APPOINTMENT, source)).toEqual({ isLate: false, lateMinutes: 0 });
    }
  });

  it('위치로 잡은 도착: +5분 초과 지각, −2분 미만 제시간, 그 사이(−2 ~ +5분)는 판정 보류(null)', () => {
    expect(judgeArrival(min(8), APPOINTMENT, 'LOCATION')).toEqual({ isLate: true, lateMinutes: 8 });
    expect(judgeArrival(min(-3), APPOINTMENT, 'LOCATION')).toEqual({ isLate: false, lateMinutes: 0 });
    expect(judgeArrival(min(-2), APPOINTMENT, 'LOCATION')).toEqual({ isLate: null, lateMinutes: null });
    expect(judgeArrival(min(0), APPOINTMENT, 'LOCATION')).toEqual({ isLate: null, lateMinutes: null });
    expect(judgeArrival(min(5), APPOINTMENT, 'LOCATION')).toEqual({ isLate: null, lateMinutes: null });
  });
});

describe('출처 우선순위 (decideWrite) — 응답(BUTTON · MANUAL) > 위치(LOCATION), 같은 출처끼리는 먼저 쓴 값', () => {
  const empty = { present: false, byResponse: false };
  const byLocation = { present: true, byResponse: false };
  const byTap = { present: true, byResponse: true };

  it('빈 칸이면 어떤 출처든 씀', () => {
    for (const source of ['BUTTON', 'MANUAL', 'LOCATION'] as const) expect(decideWrite(source, empty)).toBe('new');
  });

  it('위치로 쓴 값은 응답이 덮음 (원탭 · 직접 입력)', () => {
    expect(decideWrite('BUTTON', byLocation)).toBe('override');
    expect(decideWrite('MANUAL', byLocation)).toBe('override');
  });

  it('응답으로 쓴 값은 위치가 못 덮고, 응답끼리도 먼저 쓴 값을 유지', () => {
    expect(decideWrite('LOCATION', byTap)).toBe('keep');
    expect(decideWrite('BUTTON', byTap)).toBe('keep');
    expect(decideWrite('MANUAL', byTap)).toBe('keep');
  });

  it('위치끼리도 먼저 쓴 값을 유지', () => {
    expect(decideWrite('LOCATION', byLocation)).toBe('keep');
  });
});

describe('준비 실측 (prepareMinutesOf, #41 · 7장 B) — 출발 − max(실제 기상, 예정 기상)', () => {
  it('실제 기상이 예정보다 늦으면 실제 기상부터 (늦게 일어난 만큼은 준비가 아님)', () => {
    expect(prepareMinutesOf(at('09:05'), at('08:12'), at('08:00'))).toBe(53);
  });

  it('알람 전에 깬 시간은 세지 않음 — 예정 8:00 · 실제 7:00 · 출발 9:00이면 60분', () => {
    expect(prepareMinutesOf(at('09:00'), at('07:00'), at('08:00'))).toBe(60);
  });

  it('둘 중 하나만 있으면 그것으로, 둘 다 없거나 출발이 기상보다 빠르면 null (비움)', () => {
    expect(prepareMinutesOf(at('09:00'), at('07:30'), null)).toBe(90);
    expect(prepareMinutesOf(at('09:00'), null, at('08:00'))).toBe(60);
    expect(prepareMinutesOf(at('09:00'), null, null)).toBeNull();
    expect(prepareMinutesOf(at('07:00'), at('07:30'), at('08:00'))).toBeNull();
    expect(prepareMinutesOf(at('08:00'), null, at('08:00'))).toBeNull();
  });

  it('이미 값이 있으면 덮지 않음, 단 이 참여 조건의 이전 출발로 셈한 값이면 다시 씀', () => {
    expect(mayWritePrepare(null, null)).toBe(true);
    expect(mayWritePrepare(60, null)).toBe(false);
    expect(mayWritePrepare(60, 55)).toBe(false);
    expect(mayWritePrepare(60, 60)).toBe(true);
  });
});

describe('DB에 쓰기 (recordParticipantTimes)', () => {
  const participantRow = (patch: { departed_at?: string | null; arrived_at?: string | null; appointment_at?: string | null } = {}) => ({
    participant_id: 'p-1',
    departed_at: patch.departed_at ?? null,
    arrived_at: patch.arrived_at ?? null,
    appointments: patch.appointment_at === null ? null : { appointment_at: patch.appointment_at ?? new Date(APPOINTMENT).toISOString() },
  });
  const respond = (fn: (call: FakeCall) => FakeResult | undefined) => fn;
  const only = (table: string, op: FakeCall['op']) => mockCalls.filter((c) => c.table === table && c.op === op);
  // 응답(원탭)으로 남은 출발 · 도착 기록 한 줄
  const tapEvent = (kind: 'DEPARTURE' | 'ARRIVE', time: string, input_source: string = 'BUTTON') => ({
    event_type: kind === 'DEPARTURE' ? 'ACKNOWLEDGED' : 'ARRIVAL_CONFIRMED',
    event_at: time,
    alarms: { alarm_type: kind, participant_id: 'p-1' },
    input_source,
  });

  // 기본: 참여 조건 하나 + 그날 예정 기상 8:00, 아직 그날 기록 행 없음
  function setup(opts: { participant?: ReturnType<typeof participantRow>; events?: unknown[]; record?: Record<string, unknown> | null; wakeAt?: string | null } = {}) {
    mockRoutes = {
      'appointment_participants:select': respond(() => ({ data: opts.participant ?? participantRow() })),
      'alarm_events:select': respond(() => ({ data: opts.events ?? [] })),
      'daily_records:select': respond(() => ({ data: opts.record === undefined ? null : opts.record })),
      'alarms:select': respond(() => ({ data: opts.wakeAt === null ? [] : [{ scheduled_at: opts.wakeAt ?? iso('08:00') }] })),
    };
  }

  const run = (patch: Partial<RecordTimesInput> & { source: RecordTimesInput['source'] }) => recordParticipantTimes({ participantId: 'p-1', ...patch });

  beforeEach(() => {
    mockCalls.length = 0;
    mockRoutes = {};
  });

  describe('출발', () => {
    it('빈 칸이면 씀 — 읽은 뒤 그 사이 다른 곳이 쓴 값을 덮지 않게 비어 있을 때만(is null), 내 참여 조건만', async () => {
      setup();
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result).toMatchObject({ departed: 'new', arrived: null });
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ departed_at: iso('09:00') });
      expect(filterArgs(write, 'eq', 'participant_id')).toEqual(['p-1']);
      expect(filterArgs(write, 'eq', 'user_id')).toEqual(['user-1']);
      expect(filterArgs(write, 'is', 'departed_at')).toEqual([null]);
      expect(only('alarm_events', 'select')).toEqual([]); // 빈 칸이면 출처를 알아볼 필요 없음
    });

    it('위치가 쓴 값(그 시각의 응답 기록이 없음)은 원탭이 덮음 — 읽은 값 그대로일 때만(eq)', async () => {
      const stored = new Date(at('08:50')).toISOString();
      setup({ participant: participantRow({ departed_at: stored }), events: [] });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result.departed).toBe('override');
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ departed_at: iso('09:00') });
      expect(filterArgs(write, 'eq', 'departed_at')).toEqual([stored]);
      const [read] = only('alarm_events', 'select');
      expect(filterArgs(read, 'eq', 'alarms.participant_id')).toEqual(['p-1']);
      expect(filterArgs(read, 'in', 'input_source')).toEqual([['BUTTON', 'MANUAL']]);
    });

    it('응답으로 쓴 값(같은 시각의 원탭 기록이 있음)은 위치도 다른 원탭도 못 덮음', async () => {
      const stored = iso('09:00');
      setup({ participant: participantRow({ departed_at: stored }), events: [tapEvent('DEPARTURE', stored)] });
      expect((await run({ departedAt: at('09:10'), source: 'LOCATION' })).departed).toBe('keep');
      expect((await run({ departedAt: at('08:50'), source: 'BUTTON' })).departed).toBe('keep');
      expect((await run({ departedAt: at('08:50'), source: 'MANUAL' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('위치는 값이 있으면 출처를 알아보지 않고 그대로 둠, 빈 칸이면 씀', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:50') }) });
      expect((await run({ departedAt: at('09:00'), source: 'LOCATION' })).departed).toBe('keep');
      expect(only('alarm_events', 'select')).toEqual([]);
      expect(only('appointment_participants', 'update')).toEqual([]);

      setup();
      expect((await run({ departedAt: at('09:00'), source: 'LOCATION' })).departed).toBe('new');
      expect(only('appointment_participants', 'update')).toHaveLength(1);
    });

    it('도착 알람의 원탭 기록은 출발 값의 출처로 안 침 (종류가 다름)', async () => {
      const stored = iso('09:00');
      setup({ participant: participantRow({ departed_at: stored }), events: [tapEvent('ARRIVE', stored)] });
      expect((await run({ departedAt: at('09:10'), source: 'BUTTON' })).departed).toBe('override');
    });
  });

  describe('도착 · 지각', () => {
    it('원탭 도착: 도착 시각과 함께 is_late · late_minutes (약속 + 5분 초과면 지각)', async () => {
      setup();
      const result = await run({ arrivedAt: min(8), source: 'BUTTON' });
      expect(result).toMatchObject({ arrived: 'new', departed: null, prepareMinutes: null });
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ arrived_at: new Date(min(8)).toISOString(), is_late: true, late_minutes: 8 });
      expect(filterArgs(write, 'is', 'arrived_at')).toEqual([null]);
    });

    it('원탭 도착이 제시간이면 is_late false · late_minutes 0 (지금과 같은 결과)', async () => {
      setup();
      await run({ arrivedAt: min(-3), source: 'BUTTON' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: new Date(min(-3)).toISOString(), is_late: false, late_minutes: 0 });
    });

    it('위치로 잡은 도착이 경계 구간(−2 ~ +5분)이면 지각 판정을 보류 — is_late · late_minutes NULL', async () => {
      setup();
      await run({ arrivedAt: min(3), source: 'LOCATION' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: new Date(min(3)).toISOString(), is_late: null, late_minutes: null });
    });

    it('보류로 남은 위치 도착을 나중에 원탭이 덮어 확정 — 읽은 값 그대로일 때만, 응답 기준으로 다시 판정', async () => {
      const stored = new Date(min(3)).toISOString();
      setup({ participant: participantRow({ arrived_at: stored }), events: [] });
      const result = await run({ arrivedAt: min(7), source: 'BUTTON' });
      expect(result.arrived).toBe('override');
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ arrived_at: new Date(min(7)).toISOString(), is_late: true, late_minutes: 7 });
      expect(filterArgs(write, 'eq', 'arrived_at')).toEqual([stored]);
    });

    it('원탭 도착이 있으면 위치 도착은 못 덮음', async () => {
      const stored = new Date(min(1)).toISOString();
      setup({ participant: participantRow({ arrived_at: stored }), events: [tapEvent('ARRIVE', stored)] });
      expect((await run({ arrivedAt: min(9), source: 'LOCATION' })).arrived).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('약속 시각을 못 읽으면 도착 시각만 남기고 지각은 보류', async () => {
      setup({ participant: participantRow({ appointment_at: null }) });
      await run({ arrivedAt: min(8), source: 'BUTTON' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: new Date(min(8)).toISOString(), is_late: null, late_minutes: null });
    });
  });

  describe('준비 실측 (daily_records.actual_prepare_minutes)', () => {
    it('출발이 들어오면 출발 − max(실제 기상, 예정 기상) — 그날 행이 없으면 만듦 (출처 LOCATION이어도)', async () => {
      setup({ record: null });
      const result = await run({ departedAt: at('09:00'), source: 'LOCATION' });
      expect(result.prepareMinutes).toBe(60); // 예정 기상 8:00, 실제 기상 기록 없음
      const [insert] = only('daily_records', 'insert');
      expect(insert.payload).toEqual({ user_id: 'user-1', record_date: '2025-05-22', actual_prepare_minutes: 60, data_source: 'ALARM' });
      const [wake] = only('alarms', 'select');
      expect(filterArgs(wake, 'eq', 'alarm_type')).toEqual(['WAKE']);
      expect(filterArgs(wake, 'eq', 'is_enabled')).toEqual([true]);
      expect(filterArgs(wake, 'gte', 'scheduled_at')).toEqual([new Date(at('00:00')).toISOString()]); // 그날 0시(한국)부터 다음 날 0시 전까지
      expect(filterArgs(wake, 'lt', 'scheduled_at')).toEqual([new Date(at('00:00') + 24 * 3_600_000).toISOString()]);
    });

    it('실제 기상이 예정보다 늦으면 실제 기상부터 (8:12 기상 · 9:05 출발 = 53분), 그날 행이 있으면 갱신', async () => {
      setup({ record: { record_id: 'r1', wake_confirmed_at: iso('08:12'), actual_prepare_minutes: null } });
      expect((await run({ departedAt: at('09:05'), source: 'BUTTON' })).prepareMinutes).toBe(53);
      expect(only('daily_records', 'insert')).toEqual([]);
      const [update] = only('daily_records', 'update');
      expect(update.payload).toEqual({ actual_prepare_minutes: 53 });
      expect(filterArgs(update, 'eq', 'record_date')).toEqual(['2025-05-22']);
      expect(filterArgs(update, 'eq', 'user_id')).toEqual(['user-1']);
      expect(filterArgs(update, 'is', 'actual_prepare_minutes')).toEqual([null]); // 비어 있을 때만
    });

    it('알람 전에 일찍 깬 시간은 세지 않음 (7:00 기상 · 예정 8:00 · 9:00 출발 = 60분)', async () => {
      setup({ record: { record_id: 'r1', wake_confirmed_at: iso('07:00'), actual_prepare_minutes: null } });
      expect((await run({ departedAt: at('09:00'), source: 'BUTTON' })).prepareMinutes).toBe(60);
    });

    it('기상 기록이 둘 다 없으면 비움 (그날 행도 만들지 않음)', async () => {
      setup({ record: null, wakeAt: null });
      expect((await run({ departedAt: at('09:00'), source: 'BUTTON' })).prepareMinutes).toBeNull();
      expect(only('daily_records', 'insert')).toEqual([]);
      expect(only('daily_records', 'update')).toEqual([]);
    });

    it('이미 값이 있으면 덮지 않음 — 같은 날 두 번째 약속의 출발은 준비 실측이 아님 (먼저 들어온 출발 기준)', async () => {
      setup({ record: { record_id: 'r1', wake_confirmed_at: iso('08:00'), actual_prepare_minutes: 55 } });
      const result = await run({ departedAt: at('15:00'), source: 'BUTTON' });
      expect(result.departed).toBe('new');
      expect(result.prepareMinutes).toBeNull();
      expect(only('daily_records', 'update')).toEqual([]);
      expect(only('daily_records', 'insert')).toEqual([]);
    });

    it('위치가 쓴 출발을 원탭이 덮으면 그 출발로 셈한 준비 실측도 새 출발로 다시 씀 (읽은 값 그대로일 때만)', async () => {
      // 위치 출발 8:50 -> 준비 50분이 적힘. 원탭 9:00으로 덮이면 60분
      setup({
        participant: participantRow({ departed_at: iso('08:50') }),
        events: [],
        record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 50 },
      });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result).toMatchObject({ departed: 'override', prepareMinutes: 60 });
      const [update] = only('daily_records', 'update');
      expect(update.payload).toEqual({ actual_prepare_minutes: 60 });
      expect(filterArgs(update, 'eq', 'actual_prepare_minutes')).toEqual([50]);
    });

    it('덮은 출발이어도 지금 준비 실측이 다른 약속의 출발로 셈한 값이면 그대로', async () => {
      setup({
        participant: participantRow({ departed_at: iso('08:50') }),
        events: [],
        record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 35 }, // 8:50 출발로 셈하면 50분인데 35분 — 다른 출발의 값
      });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result.departed).toBe('override');
      expect(result.prepareMinutes).toBeNull();
      expect(only('daily_records', 'update')).toEqual([]);
    });

    it('출발이 기상보다 빠르면(기록이 어긋남) 비움', async () => {
      setup({ record: { record_id: 'r1', wake_confirmed_at: iso('09:30'), actual_prepare_minutes: null }, wakeAt: iso('09:00') });
      expect((await run({ departedAt: at('09:00'), source: 'BUTTON' })).prepareMinutes).toBeNull();
    });

    it('그날 행을 만드는 사이 다른 곳이 먼저 만들었으면(23505) 비어 있는 칸만 채움', async () => {
      setup({ record: null });
      mockRoutes['daily_records:insert'] = respond(() => ({ error: { code: '23505', message: 'duplicate key' } }));
      mockRoutes['daily_records:select'] = respond((call) => (mockCalls.filter((c) => c.table === 'daily_records' && c.op === 'select').length <= 1 ? { data: null } : { data: { actual_prepare_minutes: null } }));
      expect((await run({ departedAt: at('09:00'), source: 'BUTTON' })).prepareMinutes).toBe(60);
      const [update] = only('daily_records', 'update');
      expect(update.payload).toEqual({ actual_prepare_minutes: 60 });
      expect(filterArgs(update, 'is', 'actual_prepare_minutes')).toEqual([null]);
    });

    it('도착만 들어오면 준비 실측은 건드리지 않음', async () => {
      setup();
      await run({ arrivedAt: min(3), source: 'BUTTON' });
      expect(mockCalls.filter((c) => c.table === 'daily_records' || c.table === 'alarms')).toEqual([]);
    });
  });

  describe('같은 입력으로 다시 불려도 같은 결과 · 오류', () => {
    it('이미 응답으로 쓴 같은 값으로 다시 부르면 아무것도 안 바뀜 (훅이 던져 기록이 다시 넘어온 경우)', async () => {
      const stored = iso('09:00');
      const arrivedStored = new Date(min(8)).toISOString();
      setup({
        participant: participantRow({ departed_at: stored, arrived_at: arrivedStored }),
        events: [tapEvent('DEPARTURE', stored), tapEvent('ARRIVE', arrivedStored)],
        record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 60 },
      });
      const result = await run({ departedAt: at('09:00'), arrivedAt: min(8), source: 'BUTTON' });
      expect(result).toEqual({ departed: 'keep', arrived: 'keep', prepareMinutes: null });
      expect(mockCalls.filter((c) => c.op !== 'select')).toEqual([]);
    });

    it('앞 시도가 준비 실측을 쓰기 전에 끊겼으면 다시 불렀을 때 채움 (출발은 이미 쓴 상태)', async () => {
      const stored = iso('09:00');
      setup({ participant: participantRow({ departed_at: stored }), events: [tapEvent('DEPARTURE', stored)], record: null });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result).toMatchObject({ departed: 'keep', prepareMinutes: 60 });
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('받은 시각이 없거나 참여 조건이 없으면(지워짐) 아무것도 안 함', async () => {
      setup();
      expect(await run({ source: 'BUTTON' })).toEqual({ departed: null, arrived: null, prepareMinutes: null });
      expect(mockCalls).toEqual([]);
      mockRoutes['appointment_participants:select'] = respond(() => ({ data: null }));
      expect(await run({ departedAt: at('09:00'), source: 'BUTTON' })).toEqual({ departed: null, arrived: null, prepareMinutes: null });
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('일시 오류는 던짐 — 읽기 · 쓰기 · 준비 실측 어디서든 (부르는 쪽이 다시 부름)', async () => {
      setup();
      mockRoutes['appointment_participants:select'] = respond(() => ({ error: { code: '', message: 'offline' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'offline' });

      setup();
      mockRoutes['appointment_participants:update'] = respond(() => ({ error: { code: '', message: 'timeout' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'timeout' });

      setup();
      mockRoutes['daily_records:select'] = respond(() => ({ error: { code: '', message: 'read failed' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'read failed' });
    });
  });
});
