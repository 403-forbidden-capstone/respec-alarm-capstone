import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DETECTION_DELAY_MAX_MINUTES, TRAVEL_CORRECTION_MINUTES } from '@/features/location/constants';

import { filterArgs, type FakeCall, type FakeResult } from '../testkit/fakeSupabase';
import {
  decideWrite,
  geoEventId,
  judgeArrival,
  LATE_AFTER_MINUTES,
  LOCATION_LATE_AFTER_MINUTES,
  mayWritePrepare,
  prepareMinutesOf,
  recordParticipantTimes,
  storedSource,
  travelMinutesOf,
  type RecordTimesInput,
} from '../participantTimes';

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
const isoMs = (ms: number) => new Date(ms).toISOString();

// 시드 좌표 — 집 · 세종대(약 1.7km), 집에서 약 280m
const HOME = { lat: 37.5445, lng: 127.056 };
const SEJONG = { lat: 37.5509, lng: 127.0736 };
const NEAR_HOME = { lat: 37.547, lng: 127.056 };

describe('지각 판정 (judgeArrival, D58 · #41)', () => {
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

  it('위치 도착 지각 경계 +11분 = 응답 경계 +5분 + 감지 지연 최대 6분 (D61)', () => {
    expect(LOCATION_LATE_AFTER_MINUTES).toBe(11);
    expect(LOCATION_LATE_AFTER_MINUTES).toBe(LATE_AFTER_MINUTES + DETECTION_DELAY_MAX_MINUTES);
  });

  it('위치로 잡은 도착은 바로 확정 — 보류(null) 없음: +11분까지 지각 아님, 넘으면 지각 (D61 + 지형님 10/29 흐름 확인)', () => {
    for (const m of [-30, -2, 0, 8, 11]) expect(judgeArrival(min(m), APPOINTMENT, 'LOCATION')).toEqual({ isLate: false, lateMinutes: 0 }); // 원탭이면 지각인 +8분도 지각 아님
    expect(judgeArrival(min(11) + 1000, APPOINTMENT, 'LOCATION').isLate).toBe(true);
  });

  it('위치 도착의 지각 분은 감지 지연(6분)을 뺀 값 — 지각이면 늘 5분 이상이라 응답 기준과 맞음', () => {
    expect(judgeArrival(min(11) + 1000, APPOINTMENT, 'LOCATION')).toEqual({ isLate: true, lateMinutes: 5 });
    expect(judgeArrival(min(11.6), APPOINTMENT, 'LOCATION')).toEqual({ isLate: true, lateMinutes: 6 });
    expect(judgeArrival(min(20), APPOINTMENT, 'LOCATION')).toEqual({ isLate: true, lateMinutes: 14 });
  });
});

describe('지금 값의 출처 (storedSource) — 출처 칸, 비어 있으면 옛 앱 원탭 값', () => {
  it('시각이 없으면 null, 출처 칸이 있으면 그대로, 시각만 있고 출처가 비면 BUTTON', () => {
    expect(storedSource(null, null)).toBeNull();
    expect(storedSource(iso('09:00'), 'LOCATION')).toBe('LOCATION');
    expect(storedSource(iso('09:00'), 'MANUAL')).toBe('MANUAL');
    expect(storedSource(iso('09:00'), null)).toBe('BUTTON');
  });
});

describe('출처 우선순위 (decideWrite) — 응답(BUTTON · MANUAL) > 위치(LOCATION)', () => {
  const STORED = at('08:20');
  const empty = { atMs: null, byResponse: false };
  const byLocation = { atMs: STORED, byResponse: false };
  const byTap = { atMs: STORED, byResponse: true };
  const incoming = (source: 'BUTTON' | 'MANUAL' | 'LOCATION', hhmm = '08:50') => ({ source, atMs: at(hhmm) });

  it('빈 칸이면 어떤 출처든 씀', () => {
    for (const kind of ['DEPART', 'ARRIVE'] as const) {
      for (const source of ['BUTTON', 'MANUAL', 'LOCATION'] as const) expect(decideWrite(kind, incoming(source), empty)).toBe('new');
    }
  });

  it('위치로 쓴 값은 응답이 덮음 (원탭 · 직접 입력) — 시각이 이르든 늦든', () => {
    for (const kind of ['DEPART', 'ARRIVE'] as const) {
      expect(decideWrite(kind, incoming('BUTTON'), byLocation)).toBe('override');
      expect(decideWrite(kind, incoming('MANUAL', '08:00'), byLocation)).toBe('override');
    }
  });

  it('응답으로 쓴 값은 위치가 못 덮고, 응답끼리도 먼저 쓴 값을 유지', () => {
    for (const source of ['LOCATION', 'BUTTON', 'MANUAL'] as const) {
      expect(decideWrite('DEPART', incoming(source), byTap)).toBe('keep');
      expect(decideWrite('ARRIVE', incoming(source), byTap)).toBe('keep');
    }
  });

  it('위치 출발끼리는 더 늦은 출발로 바꿈 — 약속 전 마지막 출발 (7.13.7), 같거나 이른 출발(재전송 · 순서 뒤바뀜)은 그대로', () => {
    expect(decideWrite('DEPART', incoming('LOCATION', '08:50'), byLocation)).toBe('override');
    expect(decideWrite('DEPART', incoming('LOCATION', '08:20'), byLocation)).toBe('keep');
    expect(decideWrite('DEPART', incoming('LOCATION', '08:00'), byLocation)).toBe('keep');
  });

  it('위치 도착끼리는 먼저 쓴 값 유지 (도착 = 처음 들어온 시각)', () => {
    expect(decideWrite('ARRIVE', incoming('LOCATION', '08:50'), byLocation)).toBe('keep');
    expect(decideWrite('ARRIVE', incoming('LOCATION', '08:00'), byLocation)).toBe('keep');
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

describe('실제 이동시간 (travelMinutesOf) — 도착 − 출발, 7.3.1 학습은 L1', () => {
  const base: Parameters<typeof travelMinutesOf>[0] = { departedAtMs: at('08:50'), arrivedAtMs: at('09:42'), departedSource: 'BUTTON', arrivedSource: 'BUTTON', origin: HOME, dest: SEJONG, departAtMs: at('08:50'), appointmentAtMs: APPOINTMENT };

  it('출발지 ~ 목적지가 500m를 넘으면 분 단위로', () => {
    expect(travelMinutesOf(base)).toBe(52);
  });

  it('반경 보정 — 출발 · 도착이 둘 다 위치(LOCATION)로 잰 값일 때만 4분을 더함, 한쪽이라도 응답(원탭 · 직접 입력)이면 그대로 (7장 7.13.7 반경 보정)', () => {
    expect(TRAVEL_CORRECTION_MINUTES).toBe(4);
    expect(travelMinutesOf({ ...base, departedSource: 'LOCATION', arrivedSource: 'LOCATION' })).toBe(56);
    expect(travelMinutesOf({ ...base, departedSource: 'LOCATION', arrivedSource: 'BUTTON' })).toBe(52);
    expect(travelMinutesOf({ ...base, departedSource: 'MANUAL', arrivedSource: 'LOCATION' })).toBe(52);
    expect(travelMinutesOf({ ...base, departedSource: 'BUTTON', arrivedSource: 'MANUAL' })).toBe(52);
  });

  it('보정이 있어도 500m 안은 null, 도착이 출발보다 빠르거나 같으면 null (보정으로 살리지 않음)', () => {
    const location: typeof base = { ...base, departedSource: 'LOCATION', arrivedSource: 'LOCATION' };
    expect(travelMinutesOf({ ...location, dest: NEAR_HOME })).toBeNull();
    expect(travelMinutesOf({ ...location, arrivedAtMs: at('08:50') })).toBeNull();
    expect(travelMinutesOf({ ...location, arrivedAtMs: at('08:48') })).toBeNull();
  });

  it('500m 안(가까운 약속) · 좌표가 없으면 안 셈 (D68 · L6 안건후보: 가까운 약속 감지 기본안)', () => {
    expect(travelMinutesOf({ ...base, dest: NEAR_HOME })).toBeNull();
    expect(travelMinutesOf({ ...base, origin: null })).toBeNull();
    expect(travelMinutesOf({ ...base, dest: null })).toBeNull();
  });

  it('출발이 출발 예정 60분 전보다 이르면 안 셈 — 감시 창 W_geo를 표본 범위로 씀, 작성자 판단 (60분 전 그 시각은 셈)', () => {
    expect(travelMinutesOf({ ...base, departedAtMs: at('07:50') - 1000 })).toBeNull();
    expect(travelMinutesOf({ ...base, departedAtMs: at('07:50') })).toBe(112);
  });

  it('도착이 출발보다 빠르거나 같으면(기록이 어긋남) 안 셈', () => {
    expect(travelMinutesOf({ ...base, arrivedAtMs: at('08:50') })).toBeNull();
    expect(travelMinutesOf({ ...base, arrivedAtMs: at('08:40') })).toBeNull();
  });
});

describe('DB에 쓰기 (recordParticipantTimes)', () => {
  type Source = 'BUTTON' | 'MANUAL' | 'LOCATION' | null;
  type Patch = {
    departed_at?: string | null;
    departed_source?: Source;
    arrived_at?: string | null;
    arrived_source?: Source;
    appointment_at?: string | null;
    dest?: { lat: number; lng: number } | null;
    origin?: { lat: number; lng: number } | null;
    actual_travel_minutes?: number | null;
    alarms?: { alarm_id: string; alarm_type: string; scheduled_at: string }[];
  };
  // 출처는 시각이 있으면 주어진 값(기본 BUTTON), 시각이 없으면 비움 — DB 제약과 같은 모양
  const participantRow = (patch: Patch = {}) => ({
    participant_id: 'p-1',
    appointment_id: 'ap-1',
    departed_at: patch.departed_at ?? null,
    departed_source: patch.departed_at ? (patch.departed_source === undefined ? 'BUTTON' : patch.departed_source) : null,
    arrived_at: patch.arrived_at ?? null,
    arrived_source: patch.arrived_at ? (patch.arrived_source === undefined ? 'BUTTON' : patch.arrived_source) : null,
    actual_travel_minutes: patch.actual_travel_minutes ?? null,
    origin_lat: patch.origin?.lat ?? null,
    origin_lng: patch.origin?.lng ?? null,
    est_travel_minutes: 50,
    buffer_minutes: 10,
    appointments:
      patch.appointment_at === null
        ? null
        : { appointment_at: patch.appointment_at ?? new Date(APPOINTMENT).toISOString(), dest_lat: patch.dest?.lat ?? null, dest_lng: patch.dest?.lng ?? null },
    alarms: patch.alarms ?? [],
  });
  const ALARMS = [
    { alarm_id: 'al-dep', alarm_type: 'DEPARTURE', scheduled_at: iso('08:50') },
    { alarm_id: 'al-arr', alarm_type: 'ARRIVE', scheduled_at: iso('09:50') },
  ];
  const respond = (fn: (call: FakeCall) => FakeResult | undefined) => fn;
  const only = (table: string, op: FakeCall['op']) => mockCalls.filter((c) => c.table === table && c.op === op);

  // 기본: 참여 조건 하나 + 그날 예정 기상 8:00, 아직 그날 기록 행 없음, 집 좌표 있음
  // 쓰기(update ... select)는 기본으로 한 줄을 바꿈 — 0줄(그 사이 다른 곳이 바꿈)은 시험마다 따로
  function setup(opts: { participant?: ReturnType<typeof participantRow>; record?: Record<string, unknown> | null; wakeAt?: string | null; home?: { lat: number; lng: number } | null } = {}) {
    mockRoutes = {
      'appointment_participants:select': respond(() => ({ data: opts.participant ?? participantRow() })),
      'appointment_participants:update': respond(() => ({ data: [{ participant_id: 'p-1' }] })),
      'daily_records:select': respond(() => ({ data: opts.record === undefined ? null : opts.record })),
      'alarms:select': respond(() => ({ data: opts.wakeAt === null ? [] : [{ scheduled_at: opts.wakeAt ?? iso('08:00') }] })),
      'profiles:select': respond(() => ({ data: opts.home === null ? { home_lat: null, home_lng: null } : { home_lat: (opts.home ?? HOME).lat, home_lng: (opts.home ?? HOME).lng } })),
    };
  }

  const run = (patch: Partial<RecordTimesInput> & { source: RecordTimesInput['source'] }) => recordParticipantTimes({ participantId: 'p-1', ...patch });

  beforeEach(() => {
    mockCalls.length = 0;
    mockRoutes = {};
  });

  describe('출발 · 출처 칸', () => {
    it('빈 칸이면 씀 — 읽은 뒤 그 사이 다른 곳이 쓴 값을 덮지 않게 비어 있을 때만(is null), 내 참여 조건만', async () => {
      setup();
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result).toMatchObject({ departed: 'new', arrived: null });
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ departed_at: iso('09:00'), departed_source: 'BUTTON' });
      expect(filterArgs(write, 'eq', 'participant_id')).toEqual(['p-1']);
      expect(filterArgs(write, 'eq', 'user_id')).toEqual(['user-1']);
      expect(filterArgs(write, 'is', 'departed_at')).toEqual([null]);
    });

    it('출처는 출처 칸에서 읽음 — 같은 시각의 응답 기록(alarm_events)으로 짐작하지 않음', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(mockCalls.filter((c) => c.table === 'alarm_events')).toEqual([]);
      const [read] = only('appointment_participants', 'select');
      expect(read.columns).toContain('departed_source');
      expect(read.columns).toContain('arrived_source');
    });

    it('위치가 쓴 값은 원탭이 덮음 — 출처도 응답 것으로 바뀜, 읽은 값 그대로일 때만(eq)', async () => {
      const stored = iso('08:50');
      setup({ participant: participantRow({ departed_at: stored, departed_source: 'LOCATION' }) });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result.departed).toBe('override');
      const [write] = only('appointment_participants', 'update');
      // 바뀐 출발로 셈한 이동시간은 같은 줄에서 비움 (clearLocationTime과 같은 규칙)
      expect(write.payload).toEqual({ departed_at: iso('09:00'), departed_source: 'BUTTON', actual_travel_minutes: null });
      expect(filterArgs(write, 'eq', 'departed_at')).toEqual([stored]);
    });

    it('직접 입력(MANUAL)도 위치 값을 덮음', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      expect((await run({ departedAt: at('09:00'), source: 'MANUAL' })).departed).toBe('override');
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ departed_at: iso('09:00'), departed_source: 'MANUAL', actual_travel_minutes: null });
    });

    it('응답으로 쓴 값(출처 BUTTON)은 위치도 다른 원탭도 못 덮음', async () => {
      setup({ participant: participantRow({ departed_at: iso('09:00'), departed_source: 'BUTTON' }) });
      expect((await run({ departedAt: at('09:10'), source: 'LOCATION' })).departed).toBe('keep');
      expect((await run({ departedAt: at('08:50'), source: 'BUTTON' })).departed).toBe('keep');
      expect((await run({ departedAt: at('08:50'), source: 'MANUAL' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('옛 앱 원탭 값(시각만 있고 출처 칸이 빔)은 BUTTON으로 읽음 — 위치가 못 덮고 원탭끼리는 먼저 쓴 값', async () => {
      setup({ participant: participantRow({ departed_at: iso('09:00'), departed_source: null, arrived_at: new Date(min(1)).toISOString(), arrived_source: null }) });
      expect(await run({ departedAt: at('09:10'), arrivedAt: min(9), source: 'LOCATION' })).toMatchObject({ departed: 'keep', arrived: 'keep' });
      expect((await run({ departedAt: at('08:50'), source: 'BUTTON' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('위치 출발 위에 더 이른 · 같은 위치 출발이 늦게 오면(재전송 · 순서 뒤바뀜) 그대로, 빈 칸이면 씀', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:50'), departed_source: 'LOCATION' }), record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 50 } });
      expect((await run({ departedAt: at('08:20'), source: 'LOCATION' })).departed).toBe('keep');
      expect((await run({ departedAt: at('08:50'), source: 'LOCATION' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);

      setup();
      expect((await run({ departedAt: at('09:00'), source: 'LOCATION' })).departed).toBe('new');
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ departed_at: iso('09:00'), departed_source: 'LOCATION' });
    });

    it('위치 출발 위에 더 늦은 위치 출발 — 귀가 뒤 다시 나간 출발로 바꿈 (7.13.7 약속 전 마지막 출발), 읽은 값 그대로일 때만', async () => {
      setup({ participant: participantRow({ alarms: ALARMS, departed_at: iso('08:20'), departed_source: 'LOCATION' }), record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 20 } });
      const result = await run({ departedAt: at('08:50'), source: 'LOCATION' });
      expect(result).toMatchObject({ departed: 'override', prepareMinutes: 50 });
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ departed_at: iso('08:50'), departed_source: 'LOCATION', actual_travel_minutes: null });
      expect(filterArgs(write, 'eq', 'departed_at')).toEqual([iso('08:20')]);
      // 새 출발은 새 위치 기록 줄, 앞 출발 줄(8:20)은 지우지 않음 — '확인할 기록'
      expect((only('alarm_events', 'upsert')[0].payload as { client_event_id: string }[]).map((r) => r.client_event_id)).toEqual([geoEventId('p-1', 'DEPART', at('08:50'))]);
      expect(only('alarm_events', 'delete')).toEqual([]);
      // 앞 출발(8:20 − 예정 기상 8:00 = 20분)로 셈한 준비 실측이면 새 출발로 다시 셈
      const [prepare] = only('daily_records', 'update');
      expect(prepare.payload).toEqual({ actual_prepare_minutes: 50 });
      expect(filterArgs(prepare, 'eq', 'actual_prepare_minutes')).toEqual([20]);
    });

    it('응답 출발은 더 늦은 위치 출발도 못 덮음', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:20'), departed_source: 'BUTTON' }) });
      expect((await run({ departedAt: at('08:50'), source: 'LOCATION' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('출발 · 도착을 같이 받으면 각각 자기 출처를 씀, 안 받은 쪽 출처는 건드리지 않음', async () => {
      setup();
      await run({ departedAt: at('09:00'), arrivedAt: min(8), source: 'BUTTON' });
      const payloads = only('appointment_participants', 'update').map((c) => c.payload);
      expect(payloads).toEqual([
        { departed_at: iso('09:00'), departed_source: 'BUTTON' },
        { arrived_at: isoMs(min(8)), arrived_source: 'BUTTON', is_late: true, late_minutes: 8 },
      ]);
    });
  });

  describe('도착 · 지각', () => {
    it('원탭 도착: 도착 시각과 함께 is_late · late_minutes (약속 + 5분 초과면 지각)', async () => {
      setup();
      const result = await run({ arrivedAt: min(8), source: 'BUTTON' });
      expect(result).toMatchObject({ arrived: 'new', departed: null, prepareMinutes: null });
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ arrived_at: isoMs(min(8)), arrived_source: 'BUTTON', is_late: true, late_minutes: 8 });
      expect(filterArgs(write, 'is', 'arrived_at')).toEqual([null]);
    });

    it('원탭 도착이 제시간이면 is_late false · late_minutes 0', async () => {
      setup();
      await run({ arrivedAt: min(-3), source: 'BUTTON' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: isoMs(min(-3)), arrived_source: 'BUTTON', is_late: false, late_minutes: 0 });
    });

    it('위치로 잡은 도착은 바로 판정 — +9분은 지각 아님(보류 없음), +13분은 지각 7분 (감지 지연 6분을 뺌)', async () => {
      setup();
      await run({ arrivedAt: min(9), source: 'LOCATION' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: isoMs(min(9)), arrived_source: 'LOCATION', is_late: false, late_minutes: 0 });

      mockCalls.length = 0;
      setup();
      await run({ arrivedAt: min(13), source: 'LOCATION' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: isoMs(min(13)), arrived_source: 'LOCATION', is_late: true, late_minutes: 7 });
    });

    it('위치 도착을 원탭이 덮으면(사용자가 고친 값) 응답 기준(+5분)으로 다시 판정 — 읽은 값 그대로일 때만, 그 도착으로 셈한 이동시간도 비움', async () => {
      const stored = isoMs(min(3));
      setup({ participant: participantRow({ arrived_at: stored, arrived_source: 'LOCATION' }) });
      const result = await run({ arrivedAt: min(7), source: 'BUTTON' });
      expect(result.arrived).toBe('override');
      const [write] = only('appointment_participants', 'update');
      expect(write.payload).toEqual({ arrived_at: isoMs(min(7)), arrived_source: 'BUTTON', is_late: true, late_minutes: 7, actual_travel_minutes: null });
      expect(filterArgs(write, 'eq', 'arrived_at')).toEqual([stored]);
    });

    it('위치 도착 위에 다른 위치 도착은 그대로 (먼저 들어온 시각)', async () => {
      setup({ participant: participantRow({ arrived_at: isoMs(min(3)), arrived_source: 'LOCATION' }) });
      expect((await run({ arrivedAt: min(9), source: 'LOCATION' })).arrived).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('원탭 도착이 있으면 위치 도착은 못 덮음', async () => {
      setup({ participant: participantRow({ arrived_at: isoMs(min(1)), arrived_source: 'BUTTON' }) });
      expect((await run({ arrivedAt: min(9), source: 'LOCATION' })).arrived).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('약속 시각을 못 읽으면 도착 시각만 남기고 지각은 보류', async () => {
      setup({ participant: participantRow({ appointment_at: null }) });
      await run({ arrivedAt: min(8), source: 'BUTTON' });
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ arrived_at: isoMs(min(8)), arrived_source: 'BUTTON', is_late: null, late_minutes: null });
    });
  });

  describe('위치 기록 (alarm_events, 기록 화면 "자동 · 지오펜스")', () => {
    it('위치 출발을 쓰면 출발 알람에 ACKNOWLEDGED(LOCATION) 한 줄 — 고정 번호, 같은 번호면 무시', async () => {
      setup({ participant: participantRow({ alarms: ALARMS }) });
      await run({ departedAt: at('08:52'), source: 'LOCATION' });
      const [write] = only('alarm_events', 'upsert');
      expect(write.payload).toEqual([
        { alarm_id: 'al-dep', user_id: 'user-1', event_type: 'ACKNOWLEDGED', event_at: iso('08:52'), input_source: 'LOCATION', client_event_id: geoEventId('p-1', 'DEPART', at('08:52')) },
      ]);
      expect(write.options).toEqual({ onConflict: 'client_event_id', ignoreDuplicates: true });
    });

    it('위치 도착은 도착 알람에 ARRIVAL_CONFIRMED, 출발 · 도착을 같이 받으면 두 줄', async () => {
      setup({ participant: participantRow({ alarms: ALARMS }) });
      await run({ departedAt: at('08:52'), arrivedAt: min(-6), source: 'LOCATION' });
      const [write] = only('alarm_events', 'upsert');
      expect(write.payload).toEqual([
        expect.objectContaining({ alarm_id: 'al-dep', event_type: 'ACKNOWLEDGED', client_event_id: geoEventId('p-1', 'DEPART', at('08:52')) }),
        expect.objectContaining({ alarm_id: 'al-arr', event_type: 'ARRIVAL_CONFIRMED', event_at: isoMs(min(-6)), input_source: 'LOCATION', client_event_id: geoEventId('p-1', 'ARRIVE', min(-6)) }),
      ]);
    });

    it('그 종류의 알람 행이 없으면 안 남김 (alarm_id 필수) — 출발 알람만 있으면 출발만', async () => {
      setup();
      await run({ departedAt: at('08:52'), arrivedAt: min(-6), source: 'LOCATION' });
      expect(only('alarm_events', 'upsert')).toEqual([]);

      setup({ participant: participantRow({ alarms: [ALARMS[0]] }) });
      await run({ departedAt: at('08:52'), arrivedAt: min(-6), source: 'LOCATION' });
      expect((only('alarm_events', 'upsert')[0].payload as unknown[]).map((r) => (r as { alarm_id: string }).alarm_id)).toEqual(['al-dep']);
    });

    it('원탭 · 직접 입력은 안 남김 (원탭 기록은 폰이 올림), 위치가 못 쓴 값(응답 있음 · 다른 위치 값)도 안 남김', async () => {
      setup({ participant: participantRow({ alarms: ALARMS }) });
      await run({ departedAt: at('09:00'), source: 'BUTTON' });
      setup({ participant: participantRow({ alarms: ALARMS, departed_at: iso('09:00'), departed_source: 'BUTTON' }) });
      await run({ departedAt: at('08:52'), source: 'LOCATION' });
      setup({ participant: participantRow({ alarms: ALARMS, departed_at: iso('09:00'), departed_source: 'LOCATION' }) });
      await run({ departedAt: at('08:52'), source: 'LOCATION' }); // 지금 위치 출발보다 이름
      expect(only('alarm_events', 'upsert')).toEqual([]);
    });

    it('같은 위치 값이 이미 있으면(앞 시도가 기록 전에 끊김) 시각은 그대로 두고 같은 번호로 다시 남김', async () => {
      setup({ participant: participantRow({ alarms: ALARMS, departed_at: iso('08:52'), departed_source: 'LOCATION' }) });
      expect((await run({ departedAt: at('08:52'), source: 'LOCATION' })).departed).toBe('keep');
      expect(only('appointment_participants', 'update')).toEqual([]);
      expect((only('alarm_events', 'upsert')[0].payload as { client_event_id: string }[])[0].client_event_id).toBe(geoEventId('p-1', 'DEPART', at('08:52')));
    });
  });

  describe('실제 이동시간 (actual_travel_minutes) — 쓰기만', () => {
    // 이동시간을 쓴 줄 (출발 · 도착을 바꾸며 같이 비운 null은 뺌)
    const travelWrites = () => only('appointment_participants', 'update').filter((c) => typeof (c.payload as Record<string, unknown>).actual_travel_minutes === 'number');

    it('출발 · 도착이 다 있고 출발지(비면 집) ~ 목적지 500m 밖이면 도착 − 출발 — 출발 · 도착이 읽은 값 그대로일 때만', async () => {
      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      const result = await run({ arrivedAt: min(-8), source: 'LOCATION' });
      expect(result.travelMinutes).toBe(66); // 도착 9:52 − 출발 8:50 = 62분 + 반경 보정 4분 (둘 다 위치)
      const [write] = travelWrites();
      expect(write.payload).toEqual({ actual_travel_minutes: 66 });
      expect(filterArgs(write, 'eq', 'departed_at')).toEqual([iso('08:50')]);
      expect(filterArgs(write, 'eq', 'arrived_at')).toEqual([isoMs(min(-8))]);
      expect(only('profiles', 'select')).toHaveLength(1); // 출발지가 비어 집 좌표를 읽음
    });

    it('한쪽이라도 응답이면 반경 보정을 안 더함 (원탭 도착 + 위치 출발 = 도착 − 출발 그대로), 출발지 좌표가 있으면 집을 안 읽음', async () => {
      setup({ participant: participantRow({ dest: SEJONG, origin: HOME, departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      expect((await run({ arrivedAt: min(-5), source: 'BUTTON' })).travelMinutes).toBe(65);
      expect(only('profiles', 'select')).toEqual([]);
    });

    it('500m 안이면 안 씀', async () => {
      setup({ participant: participantRow({ dest: NEAR_HOME, departed_at: iso('09:40') }) });
      expect((await run({ arrivedAt: min(-10), source: 'BUTTON' })).travelMinutes).toBeNull();
      expect(travelWrites()).toEqual([]);
    });

    it('좌표가 없으면 안 씀 — 목적지 없음 · 출발지와 집 둘 다 없음', async () => {
      setup({ participant: participantRow({ departed_at: iso('08:50') }) });
      expect((await run({ arrivedAt: min(-8), source: 'BUTTON' })).travelMinutes).toBeNull();
      expect(only('profiles', 'select')).toEqual([]); // 목적지가 없으면 집도 안 읽음

      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:50') }), home: null });
      expect((await run({ arrivedAt: min(-8), source: 'BUTTON' })).travelMinutes).toBeNull();
      expect(travelWrites()).toEqual([]);
    });

    it('출발이 출발 예정(출발 알람 8:50) 60분 전보다 이르면 안 씀 — 감시 창 W_geo를 표본 범위로 씀, 작성자 판단 (오전 이탈이 늦은 약속에 붙은 경우)', async () => {
      setup({ participant: participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('07:30'), departed_source: 'LOCATION' }) });
      expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBeNull();
      expect(travelWrites()).toEqual([]);
    });

    it('출발 알람이 없으면 출발 예정 = 약속 − 여유 − 예상 이동 (10:00 − 10 − 50 = 9:00) → 8:00부터 셈', async () => {
      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:00'), departed_source: 'LOCATION' }) });
      expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBe(116);
      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('07:59'), departed_source: 'LOCATION' }) });
      expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBeNull();
    });

    it('이미 같은 값이면 다시 안 씀, 출발이 원탭으로 바뀌면 새 출발로 다시 씀', async () => {
      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:50'), departed_source: 'LOCATION', arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', actual_travel_minutes: 66 }) });
      expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBeNull();
      expect(travelWrites()).toEqual([]);

      expect((await run({ departedAt: at('08:55'), source: 'BUTTON' })).travelMinutes).toBe(57);
      expect(travelWrites()[0].payload).toEqual({ actual_travel_minutes: 57 });
      expect(filterArgs(travelWrites()[0], 'eq', 'departed_at')).toEqual([iso('08:55')]);
    });

    it('출발이 바뀌면 그 출발로 셈한 이동시간을 같은 줄에서 비우고 새 출발로 다시 셈 — 지금 값과 같아도 씀(비웠으므로)', async () => {
      // 출발 알람 8:50 → 감시 창 7:50부터. 위치 출발 7:55 → 도착 9:52 = 117분 + 반경 보정 4분 = 121분, 더 늦은 위치 출발 8:30으로 바뀌면 82 + 4 = 86분
      const row = (travel: number) =>
        participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('07:55'), departed_source: 'LOCATION', arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', actual_travel_minutes: travel });
      setup({ participant: row(121) });
      expect((await run({ departedAt: at('08:30'), source: 'LOCATION' })).travelMinutes).toBe(86);
      expect(only('appointment_participants', 'update')[0].payload).toMatchObject({ departed_at: iso('08:30'), actual_travel_minutes: null });
      expect(travelWrites()[0].payload).toEqual({ actual_travel_minutes: 86 });
      expect(filterArgs(travelWrites()[0], 'eq', 'departed_at')).toEqual([iso('08:30')]);

      mockCalls.length = 0;
      setup({ participant: row(86) });
      expect((await run({ departedAt: at('08:30'), source: 'LOCATION' })).travelMinutes).toBe(86);
    });

    describe('반경 보정 +4분 (7장 7.13.7 반경 보정) — 둘 다 위치일 때만', () => {
      const located = { dest: SEJONG, departed_at: iso('08:50'), departed_source: 'LOCATION' as const };

      it('출발 · 도착이 둘 다 위치면 +4, 한쪽이라도 응답이면 +0', async () => {
        setup({ participant: participantRow(located) });
        expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBe(66);

        setup({ participant: participantRow(located) });
        expect((await run({ arrivedAt: min(-8), source: 'BUTTON' })).travelMinutes).toBe(62);

        setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:50'), departed_source: 'MANUAL' }) });
        expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBe(62);
      });

      it('500m 안이면 보정이 있어도 여전히 안 씀', async () => {
        setup({ participant: participantRow({ ...located, dest: NEAR_HOME }) });
        expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBeNull();
        expect(travelWrites()).toEqual([]);
      });

      it('출처 조합이 바뀌면 비우고 다시 셈 — 위치 도착을 원탭이 덮으면 +4가 빠짐 (같은 시각이어도)', async () => {
        setup({ participant: participantRow({ ...located, arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', actual_travel_minutes: 66 }) });
        const result = await run({ arrivedAt: min(-8), source: 'BUTTON' });
        expect(result).toMatchObject({ arrived: 'override', travelMinutes: 62 });
        expect(only('appointment_participants', 'update')[0].payload).toMatchObject({ arrived_source: 'BUTTON', actual_travel_minutes: null });
        expect(travelWrites()[0].payload).toEqual({ actual_travel_minutes: 62 });
      });

      it('위치 값을 응답이 덮은 값으로 위치 도착이 다시 와도(keep) 보정을 안 더함', async () => {
        setup({ participant: participantRow({ ...located, arrived_at: isoMs(min(-8)), arrived_source: 'BUTTON', actual_travel_minutes: 62 }) });
        expect((await run({ arrivedAt: min(-9), source: 'LOCATION' })).travelMinutes).toBeNull();
        expect(travelWrites()).toEqual([]);
      });

      it('앞서 보정 없이 쓴 둘 다 위치의 이동시간은 다시 불리면 보정 값으로 바뀜', async () => {
        setup({ participant: participantRow({ ...located, arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', actual_travel_minutes: 62 }) });
        expect((await run({ arrivedAt: min(-8), source: 'LOCATION' })).travelMinutes).toBe(66);
      });
    });

    it('새 출발로는 셀 수 없으면(감시 창 전) 비운 채로 둠 — 앞 출발로 셈한 값을 남기지 않음', async () => {
      setup({ participant: participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('08:30'), departed_source: 'LOCATION', arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', actual_travel_minutes: 82 }) });
      expect((await run({ departedAt: at('07:30'), source: 'MANUAL' })).travelMinutes).toBeNull();
      expect(only('appointment_participants', 'update')[0].payload).toEqual({ departed_at: iso('07:30'), departed_source: 'MANUAL', actual_travel_minutes: null });
      expect(travelWrites()).toEqual([]);
    });

    it('한쪽만 있으면 안 셈', async () => {
      setup({ participant: participantRow({ dest: SEJONG }) });
      expect((await run({ departedAt: at('08:50'), source: 'LOCATION' })).travelMinutes).toBeNull();
      expect(only('profiles', 'select')).toEqual([]);
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
        participant: participantRow({ departed_at: iso('08:50'), departed_source: 'LOCATION' }),
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
        participant: participantRow({ departed_at: iso('08:50'), departed_source: 'LOCATION' }),
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
      mockRoutes['daily_records:select'] = respond(() => (mockCalls.filter((c) => c.table === 'daily_records' && c.op === 'select').length <= 1 ? { data: null } : { data: { actual_prepare_minutes: null } }));
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

  describe('그 사이 다른 곳이 바꿈 — 조건이 안 맞아 바뀐 줄 0 (낙관 갱신)', () => {
    const zeroRows = () => {
      mockRoutes['appointment_participants:update'] = respond(() => ({ data: [] }));
    };

    it('출발을 못 썼으면 keep — 딸린 위치 기록 · 준비 실측 · 이동시간도 안 씀 (지금 값을 모르니 바꾼 쪽이 자기 값으로 함)', async () => {
      setup({ participant: participantRow({ dest: SEJONG, alarms: ALARMS, arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION' }), record: null });
      zeroRows();
      expect(await run({ departedAt: at('08:50'), source: 'LOCATION' })).toEqual({ departed: 'keep', arrived: null, prepareMinutes: null, travelMinutes: null });
      expect(only('appointment_participants', 'update')).toHaveLength(1);
      expect(only('alarm_events', 'upsert')).toEqual([]);
      expect(mockCalls.filter((c) => c.table === 'daily_records')).toEqual([]);
    });

    it('도착을 못 썼으면 keep — 위치 기록 · 이동시간도 안 씀', async () => {
      setup({ participant: participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      zeroRows();
      expect(await run({ arrivedAt: min(-8), source: 'LOCATION' })).toEqual({ departed: null, arrived: 'keep', prepareMinutes: null, travelMinutes: null });
      expect(only('appointment_participants', 'update')).toHaveLength(1);
      expect(only('alarm_events', 'upsert')).toEqual([]);
    });

    it('이동시간을 쓰는 사이 출발 · 도착이 바뀌었으면(0줄) 쓴 값 없음', async () => {
      setup({ participant: participantRow({ dest: SEJONG, departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      mockRoutes['appointment_participants:update'] = respond((call) => ({ data: (call.payload as Record<string, unknown>).actual_travel_minutes === undefined ? [{ participant_id: 'p-1' }] : [] }));
      const result = await run({ arrivedAt: min(-8), source: 'LOCATION' });
      expect(result).toMatchObject({ arrived: 'new', travelMinutes: null });
      expect(only('appointment_participants', 'update')).toHaveLength(2); // 도착 쓰기 + 이동시간 시도
    });
  });

  describe('같은 입력으로 다시 불려도 같은 결과 · 오류', () => {
    it('이미 응답으로 쓴 같은 값으로 다시 부르면 아무것도 안 바뀜 (훅이 던져 기록이 다시 넘어온 경우)', async () => {
      setup({
        participant: participantRow({ departed_at: iso('09:00'), arrived_at: isoMs(min(8)) }),
        record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 60 },
      });
      const result = await run({ departedAt: at('09:00'), arrivedAt: min(8), source: 'BUTTON' });
      expect(result).toEqual({ departed: 'keep', arrived: 'keep', prepareMinutes: null, travelMinutes: null });
      expect(mockCalls.filter((c) => c.op !== 'select')).toEqual([]);
    });

    it('위치 값 두 번 — 처음 쓴 결과(시각 · 지각 · 기록 · 이동시간)가 두 번째에 그대로 남고 새로 쓰는 것 없음 (기록은 같은 번호라 한 줄)', async () => {
      setup({ participant: participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('08:50'), departed_source: 'LOCATION' }) });
      const first = await run({ arrivedAt: min(4), source: 'LOCATION' });
      expect(first).toMatchObject({ arrived: 'new', travelMinutes: 78 });
      const firstEvent = only('alarm_events', 'upsert')[0].payload;

      mockCalls.length = 0;
      setup({
        participant: participantRow({ dest: SEJONG, alarms: ALARMS, departed_at: iso('08:50'), departed_source: 'LOCATION', arrived_at: isoMs(min(4)), arrived_source: 'LOCATION', actual_travel_minutes: 78 }),
      });
      const second = await run({ arrivedAt: min(4), source: 'LOCATION' });
      expect(second).toEqual({ departed: null, arrived: 'keep', prepareMinutes: null, travelMinutes: null });
      expect(only('appointment_participants', 'update')).toEqual([]);
      expect(only('alarm_events', 'upsert')[0].payload).toEqual(firstEvent);
    });

    it('앞 시도가 준비 실측을 쓰기 전에 끊겼으면 다시 불렀을 때 채움 (출발은 이미 쓴 상태)', async () => {
      setup({ participant: participantRow({ departed_at: iso('09:00') }), record: null });
      const result = await run({ departedAt: at('09:00'), source: 'BUTTON' });
      expect(result).toMatchObject({ departed: 'keep', prepareMinutes: 60 });
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('귀가 뒤 재출발(override) 직후 위치 기록이 던져도 준비 실측 · 이동시간은 새 출발 기준으로 이미 들어가 있고, 같은 입력으로 다시 부르면 위치 기록만 남음', async () => {
      // 위치 출발 8:20 · 위치 도착 있음 · 준비 실측 20분 · 이동시간 있음 → 더 늦은 위치 출발 8:50으로 바뀜 (예정 기상 8:00 → 준비 50분, 8:50 → 9:52 = 62 + 4)
      const departedRow = (patch: { departed_at: string; actual_travel_minutes: number | null }) =>
        participantRow({ dest: SEJONG, alarms: ALARMS, departed_source: 'LOCATION', arrived_at: isoMs(min(-8)), arrived_source: 'LOCATION', ...patch });
      setup({ participant: departedRow({ departed_at: iso('08:20'), actual_travel_minutes: 94 }), record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 20 } });
      mockRoutes['alarm_events:upsert'] = respond(() => ({ error: { code: '', message: 'event failed' } }));
      await expect(run({ departedAt: at('08:50'), source: 'LOCATION' })).rejects.toMatchObject({ message: 'event failed' });

      // 던지기 전에 시각 · 준비 실측 · 이동시간이 새 출발 기준으로 이미 쓰임 (위치 기록이 맨 나중)
      const [stamp] = only('appointment_participants', 'update');
      expect(stamp.payload).toEqual({ departed_at: iso('08:50'), departed_source: 'LOCATION', actual_travel_minutes: null });
      expect(only('daily_records', 'update')[0].payload).toEqual({ actual_prepare_minutes: 50 });
      expect(only('appointment_participants', 'update')[1].payload).toEqual({ actual_travel_minutes: 66 });
      const order = mockCalls.filter((c) => c.op !== 'select').map((c) => `${c.table}:${c.op}`);
      expect(order.at(-1)).toBe('alarm_events:upsert');

      // 다시 부름 — DB는 이제 새 출발 · 새 준비 실측 · 새 이동시간. 위치 기록만 다시 시도되고 나머지는 안 바뀜
      mockCalls.length = 0;
      setup({ participant: departedRow({ departed_at: iso('08:50'), actual_travel_minutes: 66 }), record: { record_id: 'r1', wake_confirmed_at: null, actual_prepare_minutes: 50 } });
      const again = await run({ departedAt: at('08:50'), source: 'LOCATION' });
      expect(again).toEqual({ departed: 'keep', arrived: null, prepareMinutes: null, travelMinutes: null });
      expect(mockCalls.filter((c) => c.op !== 'select').map((c) => `${c.table}:${c.op}`)).toEqual(['alarm_events:upsert']);
      expect((only('alarm_events', 'upsert')[0].payload as { client_event_id: string }[]).map((r) => r.client_event_id)).toEqual([geoEventId('p-1', 'DEPART', at('08:50'))]);
    });

    it('받은 시각이 없거나 참여 조건이 없으면(지워짐) 아무것도 안 함', async () => {
      setup();
      expect(await run({ source: 'BUTTON' })).toEqual({ departed: null, arrived: null, prepareMinutes: null, travelMinutes: null });
      expect(mockCalls).toEqual([]);
      mockRoutes['appointment_participants:select'] = respond(() => ({ data: null }));
      expect(await run({ departedAt: at('09:00'), source: 'BUTTON' })).toEqual({ departed: null, arrived: null, prepareMinutes: null, travelMinutes: null });
      expect(only('appointment_participants', 'update')).toEqual([]);
    });

    it('일시 오류는 던짐 — 읽기 · 쓰기 · 위치 기록 · 준비 실측 어디서든 (부르는 쪽이 다시 부름)', async () => {
      setup();
      mockRoutes['appointment_participants:select'] = respond(() => ({ error: { code: '', message: 'offline' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'offline' });

      setup();
      mockRoutes['appointment_participants:update'] = respond(() => ({ error: { code: '', message: 'timeout' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'timeout' });

      setup({ participant: participantRow({ alarms: ALARMS }) });
      mockRoutes['alarm_events:upsert'] = respond(() => ({ error: { code: '', message: 'event failed' } }));
      await expect(run({ departedAt: at('09:00'), source: 'LOCATION' })).rejects.toMatchObject({ message: 'event failed' });

      setup();
      mockRoutes['daily_records:select'] = respond(() => ({ error: { code: '', message: 'read failed' } }));
      await expect(run({ departedAt: at('09:00'), source: 'BUTTON' })).rejects.toMatchObject({ message: 'read failed' });
    });
  });
});
