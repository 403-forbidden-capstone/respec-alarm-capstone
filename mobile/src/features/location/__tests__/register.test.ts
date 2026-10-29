import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { FakeCall, FakeResult } from '@/features/alarm/testkit/fakeSupabase';

import { clearOnSignOut, refreshGeofences, stopGeofences, syncLocation } from '../register';
import { commit, getLocationAuto, loadActions, loadPlan, loadRegions, loadState, setLocationAuto } from '../store';
import { GEOFENCE_TASK } from '../task';
import { initialGeoState } from '../transitions';

// 지오펜스 등록 — 서버 읽기 · 네이티브 등록은 가짜로 두고 부른 내용과 폰에 남은 값을 확인
let mockOS = 'ios'; // 맨 위 import 때는 작업을 정의하지 않게 — 아래 beforeEach가 안드로이드로 바꿈
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    get OS() {
      return mockOS;
    },
    select: (o: Record<string, unknown>) => o[mockOS] ?? o.default,
  },
}));

const mockFg = jest.fn<() => Promise<{ granted: boolean }>>();
const mockBg = jest.fn<() => Promise<{ granted: boolean }>>();
const mockStart = jest.fn<(task: string, regions: Record<string, unknown>[]) => Promise<void>>();
const mockStop = jest.fn<(task: string) => Promise<void>>();
const mockHasStarted = jest.fn<(task: string) => Promise<boolean>>();
jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
  getForegroundPermissionsAsync: () => mockFg(),
  getBackgroundPermissionsAsync: () => mockBg(),
  startGeofencingAsync: (task: string, regions: Record<string, unknown>[]) => mockStart(task, regions),
  stopGeofencingAsync: (task: string) => mockStop(task),
  hasStartedGeofencingAsync: (task: string) => mockHasStarted(task),
}));
jest.mock('expo-task-manager', () => ({ defineTask: () => {} }));

const mockRecord = jest.fn<(input: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@/features/alarm/participantTimes', () => ({ recordParticipantTimes: (input: Record<string, unknown>) => mockRecord(input) }));
jest.mock('../notice', () => ({ onDetectionNotice: () => {} }));
let mockIsMock = false;
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));
let mockUserId: string | null = 'user-1';
jest.mock('@/lib/user', () => ({ currentUserId: async () => mockUserId }));
let mockNowMs = 0;
jest.mock('@/lib/clock', () => ({ now: () => new Date(mockNowMs) }));

// 서버 읽기: 쿼리 모양을 기록하고 시험이 정한 행을 돌려줌 (진짜 RLS · 임베드는 실제 Supabase에서)
let mockRoutes: Record<string, (call: FakeCall) => FakeResult | undefined | Promise<FakeResult | undefined>> = {};
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

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const HOME = { home_lat: 37.5011, home_lng: 127.0123, home_radius_m: 200 };
const participantRow = (patch: Record<string, unknown> = {}) => ({
  participant_id: 'p1',
  origin_lat: null,
  origin_lng: null,
  departed_at: null,
  arrived_at: null,
  buffer_minutes: 10,
  est_travel_minutes: 50,
  appointments: { appointment_at: iso('10:00'), dest_lat: 37.5577, dest_lng: 127.0599, dest_radius_m: 150 },
  alarms: [
    { alarm_type: 'WAKE', scheduled_at: iso('07:00') },
    { alarm_type: 'DEPARTURE', scheduled_at: iso('08:50') },
  ],
  ...patch,
});

let profile: Record<string, unknown> | null = HOME;
let rows: Record<string, unknown>[] = [participantRow()];
const serve = () => {
  mockRoutes = {
    'profiles:select': () => ({ data: profile }),
    'appointment_participants:select': () => ({ data: rows }),
  };
};

const consoleLogs: string[] = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockOS = 'android';
  mockIsMock = false;
  mockUserId = 'user-1';
  mockNowMs = at('07:55');
  mockCalls.length = 0;
  profile = HOME;
  rows = [participantRow()];
  serve();
  mockFg.mockReset().mockResolvedValue({ granted: true });
  mockBg.mockReset().mockResolvedValue({ granted: true });
  mockStart.mockReset().mockResolvedValue(undefined);
  mockStop.mockReset().mockResolvedValue(undefined);
  mockHasStarted.mockReset().mockResolvedValue(true);
  mockRecord.mockReset().mockResolvedValue({});
  consoleLogs.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLogs.push(JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a)))));
  }
});

const nativeCalls = () => mockStart.mock.calls.length + mockStop.mock.calls.length + mockHasStarted.mock.calls.length;

describe('등록 조건 (refreshGeofences)', () => {
  it.each([
    ['웹', () => (mockOS = 'web')],
    ['iOS', () => (mockOS = 'ios')],
    ['가짜 모드', () => (mockIsMock = true)],
    ['로그아웃 상태', () => (mockUserId = null)],
    ['자동 기록 스위치 끔', () => setLocationAuto(false)],
    ['앱 사용 중 위치 권한 없음', () => mockFg.mockResolvedValue({ granted: false })],
    ['항상 허용(백그라운드) 위치 권한 없음', () => mockBg.mockResolvedValue({ granted: false })],
  ])('%s: 네이티브 등록을 안 부르고, 서버도 안 읽고, 보관함도 안 건드림', async (_name, arrange) => {
    await arrange();
    await expect(refreshGeofences()).resolves.toBe('skipped');
    expect(nativeCalls()).toBe(0);
    expect(mockCalls).toEqual([]);
    expect(await loadPlan()).toEqual({ regions: [], participants: [], untracked: [] });
    expect(await loadRegions()).toEqual([]);
  });

  it('자동 기록 스위치는 기본 켬, 끄면 로그아웃해도 그대로', async () => {
    expect(await getLocationAuto()).toBe(true);
    await setLocationAuto(false);
    expect(await getLocationAuto()).toBe(false);
    await clearOnSignOut();
    expect(await getLocationAuto()).toBe(false);
  });
});

describe('스위치를 끄거나 권한이 빠지면 등록을 끔 (stopGeofences)', () => {
  it.each([
    ['자동 기록 스위치 끔', () => setLocationAuto(false)],
    ['항상 허용 권한 빠짐', () => mockBg.mockResolvedValue({ granted: false })],
    ['앱 사용 중 권한 빠짐', () => mockFg.mockResolvedValue({ granted: false })],
  ])('%s: 이미 등록한 지오펜스를 끄고 등록 목록 · 영역 상태를 비움, 다시 켜면 새로 등록', async (_name, arrange) => {
    await refreshGeofences();
    expect(await loadRegions()).toHaveLength(2);
    await arrange();
    await expect(refreshGeofences()).resolves.toBe('skipped');
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith(GEOFENCE_TASK);
    expect(await loadRegions()).toEqual([]);
    expect((await loadState()).regions).toEqual({});

    mockStop.mockClear();
    await refreshGeofences(); // 아직 꺼진 채 — 등록이 없으니 또 끄지 않음
    expect(mockStop).not.toHaveBeenCalled();

    await setLocationAuto(true);
    mockFg.mockResolvedValue({ granted: true });
    mockBg.mockResolvedValue({ granted: true });
    await expect(refreshGeofences()).resolves.toBe('ran');
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(await loadRegions()).toHaveLength(2);
  });

  it('폰 OS 쪽 등록은 이미 없는데 목록만 남아 있으면 stop은 안 부르고 목록만 비움', async () => {
    await refreshGeofences();
    mockHasStarted.mockResolvedValue(false);
    await stopGeofences();
    expect(mockStop).not.toHaveBeenCalled();
    expect(await loadRegions()).toEqual([]);
  });

  it('끄기가 실패하면 던지지 않고 목록을 남겨 다음에 다시 시도', async () => {
    await refreshGeofences();
    mockStop.mockRejectedValueOnce(new Error('native'));
    await setLocationAuto(false);
    await expect(refreshGeofences()).resolves.toBe('skipped');
    expect(await loadRegions()).toHaveLength(2);
    await refreshGeofences();
    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(await loadRegions()).toEqual([]);
  });

  it('등록한 게 없으면 stopGeofences는 네이티브를 안 부름', async () => {
    await stopGeofences();
    expect(nativeCalls()).toBe(0);
  });
});

describe('등록 (refreshGeofences)', () => {
  it('처음: 집 + 목적지를 한 번에 등록 (이름 · 중심 · 반경 · 들어옴 · 나감), 계획 · 등록 목록 · 영역 상태를 폰에 저장', async () => {
    await expect(refreshGeofences()).resolves.toBe('ran');
    expect(mockStart).toHaveBeenCalledTimes(1);
    const [task, regions] = mockStart.mock.calls[0];
    expect(task).toBe(GEOFENCE_TASK);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual({ identifier: 'home', latitude: 37.5011, longitude: 127.0123, radius: 200, notifyOnEnter: true, notifyOnExit: true });
    expect(regions[1]).toMatchObject({ latitude: 37.5577, longitude: 127.0599, radius: 150, notifyOnEnter: true, notifyOnExit: true });

    const plan = await loadPlan();
    expect(plan.regions.map((r) => r.id)).toEqual(regions.map((r) => r.identifier));
    expect(plan.participants.map((p) => p.participantId)).toEqual(['p1']);
    expect((await loadRegions()).map((r) => r.id)).toEqual(plan.regions.map((r) => r.id));
    const state = await loadState();
    for (const region of plan.regions) expect(state.regions[region.id]).toEqual({ inside: null, registeredAt: at('07:55'), lastAt: null });
  });

  it('서버에서 내 집 · 약속을 읽음: user_id로 좁히고 약속 시각을 지금 −2시간 ~ +26시간으로 거름', async () => {
    await refreshGeofences();
    const profileCall = mockCalls.find((c) => c.table === 'profiles');
    expect(profileCall?.filters).toContainEqual(['eq', 'user_id', 'user-1']);
    const participantCall = mockCalls.find((c) => c.table === 'appointment_participants');
    expect(participantCall?.filters).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(participantCall?.filters).toContainEqual(['gte', 'appointments.appointment_at', new Date(at('07:55') - 2 * 3_600_000).toISOString()]);
    expect(participantCall?.filters).toContainEqual(['lte', 'appointments.appointment_at', new Date(at('07:55') + 26 * 3_600_000).toISOString()]);
  });

  it('하루 앞까지 미리 등록: 약속이 이튿날 새벽이어도 감시 창이 24시간 안이면 목적지가 목록에 있음', async () => {
    rows = [participantRow({ appointments: { appointment_at: new Date(at('07:55') + 25 * 3_600_000).toISOString(), dest_lat: 37.5577, dest_lng: 127.0599, dest_radius_m: 150 }, alarms: [{ alarm_type: 'DEPARTURE', scheduled_at: new Date(at('07:55') + 24.5 * 3_600_000).toISOString() }] })];
    await refreshGeofences();
    expect(mockStart.mock.calls[0][1]).toHaveLength(2);
  });

  it('출발 알람이 없으면 약속 − 여유 − 이동으로 출발 예정을 셈', async () => {
    rows = [participantRow({ alarms: [] })];
    await refreshGeofences();
    const [participant] = (await loadPlan()).participants;
    expect(participant.departAt).toBe(at('10:00') - 60 * 60_000);
  });

  it('바뀐 게 없으면 다시 등록하지 않음 (계획만 새로 저장)', async () => {
    await refreshGeofences();
    mockStart.mockClear();
    mockNowMs = at('08:10');
    await expect(refreshGeofences()).resolves.toBe('ran');
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('바뀐 게 있으면 목록 전체를 다시 등록하고, 안 바뀐 영역까지 전부 "새로 등록함"으로 기록 (안드로이드가 첫 신호를 영역마다 다시 보내므로)', async () => {
    await refreshGeofences();
    // 집은 한참 전부터 밖이었다고 기록된 상태 — 그대로 두면 다음 "이미 밖" 첫 신호를 출발로 읽을 수 있음
    const before = await loadState();
    await commit({ state: { ...before, regions: { ...before.regions, home: { inside: false, registeredAt: at('07:00'), lastAt: at('07:30') } } } });
    rows = [participantRow({ appointments: { appointment_at: iso('10:00'), dest_lat: 37.5601, dest_lng: 127.0702, dest_radius_m: 150 } })]; // 목적지만 바뀜
    mockStart.mockClear();
    mockNowMs = at('08:00');
    await refreshGeofences();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart.mock.calls[0][1]).toHaveLength(2); // 집도 같이
    const state = await loadState();
    expect(state.regions.home).toEqual({ inside: null, registeredAt: at('08:00'), lastAt: null });
    const plan = await loadPlan();
    for (const region of plan.regions) expect(state.regions[region.id]).toEqual({ inside: null, registeredAt: at('08:00'), lastAt: null });
    expect(Object.keys(state.regions).sort()).toEqual(plan.regions.map((r) => r.id).sort()); // 빠진 옛 목적지는 잊음
  });

  it('등록 시각은 등록을 부르기 전 시각 — 등록 직후 도착하는 첫 신호가 이전 등록 때 신호로 버려지지 않게', async () => {
    mockStart.mockImplementation(async () => {
      mockNowMs = at('07:56'); // 등록하는 사이 시간이 흐름
    });
    await refreshGeofences();
    expect((await loadState()).regions.home.registeredAt).toBe(at('07:55'));
  });

  it('폰 OS가 등록을 잃었으면(작업이 시작돼 있지 않음) 같은 목록이어도 다시 등록', async () => {
    await refreshGeofences();
    mockStart.mockClear();
    mockHasStarted.mockResolvedValue(false);
    await refreshGeofences();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('force: 바뀐 게 없어도 다시 등록', async () => {
    await refreshGeofences();
    mockStart.mockClear();
    await refreshGeofences({ force: true });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('감시할 곳이 없어지면(집도 약속도 없음) 등록한 것을 끄고 목록을 비움', async () => {
    await refreshGeofences();
    profile = { home_lat: null, home_lng: null, home_radius_m: null };
    rows = [];
    await refreshGeofences();
    expect(mockStop).toHaveBeenCalledWith(GEOFENCE_TASK);
    expect(await loadRegions()).toEqual([]);
    expect(await loadState()).toEqual({ ...initialGeoState(), regions: {} });
    expect((await loadPlan()).regions).toEqual([]);
  });

  it('처음부터 감시할 곳이 없으면 네이티브를 부르지 않음 (빈 목록은 등록할 수 없음)', async () => {
    profile = null;
    rows = [];
    await refreshGeofences();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockHasStarted).not.toHaveBeenCalled();
  });

  it('계획은 늘 저장 — 등록이 실패해도 (던지지 않고 false), 등록 목록은 그대로라 다음에 다시 시도', async () => {
    mockStart.mockRejectedValueOnce(new Error('Location permission is required'));
    await expect(refreshGeofences()).resolves.toBe('failed');
    expect((await loadPlan()).regions).toHaveLength(2);
    expect(await loadRegions()).toEqual([]);
    await expect(refreshGeofences()).resolves.toBe('ran');
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(await loadRegions()).toHaveLength(2);
  });

  it('서버 읽기 실패: 던지지 않고 false, 등록은 그대로', async () => {
    mockRoutes['appointment_participants:select'] = () => ({ error: { code: 'PGRST000', message: 'Failed to fetch' } });
    await expect(refreshGeofences()).resolves.toBe('failed');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('겹쳐 불러도 한 번만 등록 (두 번째는 줄에서 기다렸다가 바뀐 게 없음을 봄)', async () => {
    await Promise.all([refreshGeofences(), refreshGeofences(), refreshGeofences()]);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect((await loadState()).regions.home.registeredAt).toBe(at('07:55'));
  });

  it('앱을 열 때 5분이 지난 출발 후보를 확정해 기록 (받는 쪽에는 타이머가 없으므로)', async () => {
    await refreshGeofences();
    const state = await loadState();
    await commit({ state: { ...state, pending: [{ participantId: 'p1', regionId: 'home', at: at('07:40'), appointmentAt: at('10:00') }] } });
    mockNowMs = at('08:00');
    await refreshGeofences();
    expect(mockRecord).toHaveBeenCalledWith({ participantId: 'p1', departedAt: at('07:40'), source: 'LOCATION' });
    const after = await loadState();
    expect(after.pending).toEqual([]);
    expect(after.departed).toHaveLength(1);
    expect(await loadActions()).toEqual([]);
  });

  it('확정한 출발을 서버에 못 쓰면 보관함에 남기고, 다음 앱 열기 때 씀', async () => {
    await refreshGeofences();
    const state = await loadState();
    await commit({ state: { ...state, pending: [{ participantId: 'p1', regionId: 'home', at: at('07:40'), appointmentAt: at('10:00') }] } });
    mockRecord.mockRejectedValueOnce(new Error('offline'));
    mockNowMs = at('08:00');
    await refreshGeofences();
    expect(await loadActions()).toEqual([{ type: 'DEPART', participantId: 'p1', at: at('07:40') }]);
    mockRecord.mockClear();
    await syncLocation({ ignoreThrottle: true });
    expect(mockRecord).toHaveBeenCalledWith({ participantId: 'p1', departedAt: at('07:40'), source: 'LOCATION' });
    expect(await loadActions()).toEqual([]);
  });
});

describe('앱을 열 때 · 앞에 올 때 (syncLocation)', () => {
  it('못 쓴 기록 쓰기 → 등록 순서, 5분 안에 또 부르면 건너뜀', async () => {
    await commit({ actions: [{ type: 'ARRIVE', participantId: 'p1', at: at('07:30') }] });
    mockNowMs = at('08:00');
    await syncLocation({ ignoreThrottle: true });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);

    mockHasStarted.mockClear();
    mockNowMs = at('08:04');
    await syncLocation();
    expect(mockHasStarted).not.toHaveBeenCalled(); // 건너뜀 — 서버도 안 읽음
    expect(mockCalls.filter((c) => c.table === 'profiles')).toHaveLength(1);

    mockNowMs = at('08:05');
    await syncLocation();
    expect(mockCalls.filter((c) => c.table === 'profiles')).toHaveLength(2);
  });

  it('조건이 안 맞아 일을 안 한 때도 못 쓴 기록은 씀 (스위치를 꺼도 이미 잡은 기록은 서버에)', async () => {
    await setLocationAuto(false);
    await commit({ actions: [{ type: 'ARRIVE', participantId: 'p1', at: at('07:30') }] });
    await syncLocation({ ignoreThrottle: true });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(nativeCalls()).toBe(0);
  });

  it('실패한 뒤에는 5분을 기다리지 않고 다음 앞에 올 때 다시 함', async () => {
    // 앞 시험이 모듈 변수 lastSyncAt을 08:05에 남김 — 이 시험은 그보다 5분 뒤부터
    mockRoutes['appointment_participants:select'] = () => ({ error: { code: 'PGRST000', message: 'Failed to fetch' } });
    mockNowMs = at('08:10');
    await syncLocation({ ignoreThrottle: true });
    serve();
    mockNowMs = at('08:11');
    await syncLocation();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('권한이 없어 일을 안 한 때는 5분 제한을 걸지 않음 — 권한을 방금 허용하고 돌아오면 바로 등록', async () => {
    mockBg.mockResolvedValue({ granted: false });
    mockNowMs = at('23:00'); // 앞 시험이 남긴 마지막 동기화 시각(모듈 변수)보다 뒤
    await syncLocation({ ignoreThrottle: true });
    expect(mockStart).not.toHaveBeenCalled();

    mockBg.mockResolvedValue({ granted: true });
    mockNowMs = at('23:01'); // 5분 안
    await syncLocation();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(await loadRegions()).toHaveLength(1); // 23시라 약속(10시)은 지나 집만

    mockNowMs = at('23:02'); // 등록까지 갔으니 이제는 5분 제한
    await syncLocation();
    expect(mockCalls.filter((c) => c.table === 'profiles')).toHaveLength(1);
  });

  it('돌고 있는 중에 제한 있는 호출이 또 오면 같은 일을 기다림 (한 번만 읽음)', async () => {
    mockNowMs = at('08:00');
    await Promise.all([syncLocation({ ignoreThrottle: true }), syncLocation()]);
    expect(mockCalls.filter((c) => c.table === 'profiles')).toHaveLength(1);
  });

  it('돌고 있는 중에 ignoreThrottle 호출이 오면 끝난 뒤 한 번 더 돎 — 몇 번을 겹쳐도 한 번만 더', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    mockRoutes['profiles:select'] = async () => {
      reads += 1;
      if (reads === 1) await gate; // 첫 읽기는 붙잡아 둠
      return { data: profile };
    };
    mockNowMs = at('08:00');
    const first = syncLocation({ ignoreThrottle: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = syncLocation({ ignoreThrottle: true });
    const third = syncLocation({ ignoreThrottle: true });
    release();
    await Promise.all([first, second, third]);
    expect(reads).toBe(2);
  });
});

describe('로그아웃 (clearOnSignOut)', () => {
  it('지오펜스를 끄고 위치 기억(상태 · 계획 · 등록 목록 · 못 쓴 기록)을 지움', async () => {
    await refreshGeofences();
    await commit({ actions: [{ type: 'DEPART', participantId: 'p1', at: at('07:40') }] });
    await clearOnSignOut();
    expect(mockStop).toHaveBeenCalledWith(GEOFENCE_TASK);
    for (const key of ['state', 'plan', 'regions', 'actions']) expect(await AsyncStorage.getItem(`location:v1:${key}`)).toBeNull();
    expect(await loadState()).toEqual(initialGeoState());
  });

  it('지오펜스를 못 끄거나 켠 적이 없어도 기억은 지우고 던지지 않음', async () => {
    await refreshGeofences();
    mockStop.mockRejectedValue(new Error('native'));
    await expect(clearOnSignOut()).resolves.toBeUndefined();
    expect(await loadRegions()).toEqual([]);
    mockHasStarted.mockResolvedValue(false);
    mockStop.mockClear();
    await clearOnSignOut();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('읽는 중에 로그아웃되면 그 등록은 멈춤 — 앞 계정 집을 다시 등록하지 않음', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockRoutes['profiles:select'] = async () => {
      await gate;
      return { data: profile };
    };
    const refreshing = refreshGeofences();
    await new Promise((resolve) => setTimeout(resolve, 0)); // 서버 읽기에서 기다리는 중
    await clearOnSignOut();
    release();
    await refreshing;
    expect(mockStart).not.toHaveBeenCalled();
    expect(await loadRegions()).toEqual([]);
    expect(await loadPlan()).toEqual({ regions: [], participants: [], untracked: [] });
  });

  it('로그아웃 뒤 다시 로그인하면 새로 등록', async () => {
    await refreshGeofences();
    await clearOnSignOut();
    mockStart.mockClear();
    await refreshGeofences();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});

describe('로그에 좌표가 없음', () => {
  it('등록 실패 · 읽기 실패 · 로그아웃 정리 실패 어느 경로에도 좌표 글자가 안 나옴', async () => {
    mockStart.mockRejectedValueOnce(new Error('start failed'));
    await refreshGeofences();
    mockRoutes['profiles:select'] = () => ({ error: { code: 'PGRST000', message: 'Failed to fetch' } });
    await refreshGeofences();
    serve();
    await refreshGeofences();
    mockStop.mockRejectedValue(new Error('stop failed'));
    await clearOnSignOut();
    expect(consoleLogs.length).toBeGreaterThan(0);
    const all = consoleLogs.join('\n');
    for (const coordinate of ['37.5011', '127.0123', '37.5577', '127.0599', '37.55', '127.05']) expect(all).not.toContain(coordinate);
  });
});
