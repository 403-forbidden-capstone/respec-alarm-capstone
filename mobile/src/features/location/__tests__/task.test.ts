import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { MAX_QUEUED_ACTIONS, commit, loadActions, loadState, type WriteAction } from '../store';
import { GEOFENCE_TASK, handleGeofenceEvent } from '../task';
import type { GeoAction, GeoState } from '../transitions';
import { initialGeoState } from '../transitions';
import type { MonitoredRegion, RegionPlan, TrackedParticipant } from '../regions';

// 지오펜스 작업 처리 — 신호 → 해석 → 기록 · 보관. 네이티브 · 서버 호출은 가짜로 두고 부른 내용만 확인
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

let mockTasksLoaded = 0;
const mockDefineTask = jest.fn<(name: string, executor: unknown) => void>();
jest.mock('expo-task-manager', () => {
  mockTasksLoaded += 1;
  return { defineTask: (name: string, executor: unknown) => mockDefineTask(name, executor) };
});
jest.mock('expo-location', () => ({ GeofencingEventType: { Enter: 1, Exit: 2 } }));

const mockRecord = jest.fn<(input: Record<string, unknown>) => Promise<unknown>>();
const mockRetract = jest.fn<(input: Record<string, unknown>) => Promise<boolean>>();
const mockNotice = jest.fn<(action: GeoAction) => void>();
jest.mock('@/features/alarm/participantTimes', () => ({ recordParticipantTimes: (input: Record<string, unknown>) => mockRecord(input) }));
jest.mock('../api', () => ({ retractDeparture: (input: Record<string, unknown>) => mockRetract(input) }));
jest.mock('../notice', () => ({ onDetectionNotice: (action: GeoAction) => mockNotice(action) }));
let mockIsMock = false;
jest.mock('@/lib/mode', () => ({ isMock: () => mockIsMock }));
let mockNowMs = 0;
jest.mock('@/lib/clock', () => ({ now: () => new Date(mockNowMs) }));

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);

const HOME: MonitoredRegion = { id: 'home', lat: 37.5011, lng: 127.0123, radiusM: 200, home: true, originOf: [], destOf: [] };
const DEST: MonitoredRegion = { id: 'rdest', lat: 37.5577, lng: 127.0599, radiusM: 150, home: false, originOf: [], destOf: ['p1'] };
const P1: TrackedParticipant = { participantId: 'p1', appointmentAt: at('10:00'), departAt: at('08:50'), fromHome: true, near: false, departedAt: null, arrivedAt: null };
const PLAN: RegionPlan = { regions: [HOME, DEST], participants: [P1], untracked: [] };

// 등록한 지 한참 된 영역 — 지금 안팎을 앎 (첫 신호 예외에 안 걸림)
const known = (inside: boolean) => ({ inside, registeredAt: at('07:00'), lastAt: at('07:01') });
const seededState = (patch: Partial<GeoState> = {}): GeoState => ({ ...initialGeoState(), regions: { home: known(true), rdest: known(false) }, ...patch });

const exit = (regionId: string) => ({ data: { eventType: 2, region: { identifier: regionId } } });
const enter = (regionId: string) => ({ data: { eventType: 1, region: { identifier: regionId } } });
const run = async (body: Parameters<typeof handleGeofenceEvent>[0], nowAt: string) => {
  mockNowMs = at(nowAt);
  await handleGeofenceEvent(body);
};

const consoleLogs: string[] = [];
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockOS = 'android';
  mockIsMock = false;
  mockRecord.mockReset();
  mockRecord.mockResolvedValue({});
  mockRetract.mockReset();
  mockRetract.mockResolvedValue(true);
  consoleLogs.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLogs.push(JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a)))));
  }
  await commit({ plan: PLAN, state: seededState() });
});

describe('지오펜스 신호 받기 (handleGeofenceEvent)', () => {
  it('집 이탈 → 출발 후보: 안내만 부르고 서버에는 안 씀 (5분 기다림)', async () => {
    await run(exit('home'), '08:45');
    expect(mockNotice).toHaveBeenCalledWith({ type: 'DEPART_PENDING', participantId: 'p1', at: at('08:45') });
    expect(mockRecord).not.toHaveBeenCalled();
    expect((await loadState()).pending).toEqual([{ participantId: 'p1', regionId: 'home', at: at('08:45'), appointmentAt: at('10:00') }]);
    expect(await loadActions()).toEqual([]);
  });

  it('판정 시각은 신호를 받은 때 — 이탈 뒤 5분이 지난 도착이 오면 출발(이탈 시각) → 도착(진입 시각) 순으로 LOCATION 출처 기록', async () => {
    await run(exit('home'), '08:45');
    await run(enter('rdest'), '09:10');
    expect(mockRecord.mock.calls.map(([input]) => input)).toEqual([
      { participantId: 'p1', departedAt: at('08:45'), source: 'LOCATION' },
      { participantId: 'p1', arrivedAt: at('09:10'), source: 'LOCATION' },
    ]);
    expect(await loadActions()).toEqual([]); // 썼으니 보관함은 비어 있음
    const state = await loadState();
    expect(state.departed).toHaveLength(1);
    expect(state.arrived).toEqual([{ participantId: 'p1', at: at('09:10'), appointmentAt: at('10:00') }]);
  });

  it('5분 안에 다시 들어오면 후보를 버림: 안내 거두기만, 기록 없음', async () => {
    await run(exit('home'), '08:45');
    mockNotice.mockClear();
    await run(enter('home'), '08:48');
    expect(mockNotice).toHaveBeenCalledWith({ type: 'DEPART_CANCEL', participantId: 'p1', at: at('08:45') });
    expect(mockRecord).not.toHaveBeenCalled();
    expect((await loadState()).pending).toEqual([]);
  });

  it('도착 전 귀가: 위치로 쓴 출발을 지움 (retractDeparture, 출발 시각 그대로)', async () => {
    await commit({
      state: seededState({
        regions: { home: known(false), rdest: known(false) },
        departed: [{ participantId: 'p1', regionId: 'home', at: at('08:45'), appointmentAt: at('10:00') }],
      }),
    });
    await run(enter('home'), '09:00');
    expect(mockRetract).toHaveBeenCalledWith({ participantId: 'p1', at: at('08:45') });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('쓰기가 실패하면 보관함에 남김 (상태는 이미 앞서 나가 있으므로 기록이 사라지지 않게)', async () => {
    mockRecord.mockRejectedValue(new Error('Network request failed'));
    await run(exit('home'), '08:45');
    await run(enter('rdest'), '09:10');
    expect(await loadActions()).toEqual([
      { type: 'DEPART', participantId: 'p1', at: at('08:45') },
      { type: 'ARRIVE', participantId: 'p1', at: at('09:10') },
    ]);
    expect((await loadState()).arrived).toHaveLength(1);
  });

  it('다음 신호가 오면 보관함을 앞에서부터 먼저 비움 (순서 유지), 새 기록은 그 뒤', async () => {
    mockRecord.mockRejectedValue(new Error('offline'));
    await run(exit('home'), '08:45');
    await run(enter('rdest'), '09:10'); // 출발 · 도착이 보관됨
    mockRecord.mockReset();
    mockRecord.mockResolvedValue({});
    mockRetract.mockResolvedValue(true);
    // 아무 기록도 새로 안 만드는 신호(집 재진입 — 이미 도착했으니 출발을 지우지 않음)로 보관함 비우기만 확인
    await run(enter('home'), '09:30');
    expect(mockRecord.mock.calls.map(([input]) => input)).toEqual([
      { participantId: 'p1', departedAt: at('08:45'), source: 'LOCATION' },
      { participantId: 'p1', arrivedAt: at('09:10'), source: 'LOCATION' },
    ]);
    expect(await loadActions()).toEqual([]);
  });

  it('앞 기록이 막히면(일시 오류) 거기서 멈춤 — 뒤 기록을 앞질러 쓰지 않음', async () => {
    const queued: WriteAction[] = [
      { type: 'DEPART', participantId: 'p1', at: at('08:45') },
      { type: 'ARRIVE', participantId: 'p1', at: at('09:10') },
    ];
    await commit({ actions: queued });
    mockRecord.mockRejectedValueOnce(new Error('503'));
    await run(enter('nowhere'), '09:30');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(await loadActions()).toEqual(queued);
  });

  it('다시 해도 소용없는 오류(권한 · 외래키)는 그 기록을 버리고 다음 기록을 계속', async () => {
    await commit({
      actions: [
        { type: 'DEPART', participantId: 'p1', at: at('08:45') },
        { type: 'ARRIVE', participantId: 'p1', at: at('09:10') },
      ],
    });
    mockRecord.mockRejectedValueOnce({ code: '42501', message: 'row-level security' });
    await run(enter('nowhere'), '09:30');
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(await loadActions()).toEqual([]);
  });

  it('보관함이 상한을 넘으면 오래된 기록부터 버림', async () => {
    const many: WriteAction[] = Array.from({ length: MAX_QUEUED_ACTIONS + 5 }, (_, i) => ({ type: 'ARRIVE', participantId: `p${i}`, at: i }));
    await commit({ actions: many });
    const kept = await loadActions();
    expect(kept).toHaveLength(MAX_QUEUED_ACTIONS);
    expect(kept[0].participantId).toBe('p5');
  });

  it('작업 오류 · 모르는 영역 · 알 수 없는 신호는 무시 (기록 없음, 던지지 않음)', async () => {
    await run({ error: { message: 'location services disabled' }, data: null }, '08:45');
    await run({ data: { eventType: 99, region: { identifier: 'home' } } }, '08:46');
    await run({ data: { eventType: 2, region: {} } }, '08:47');
    await run({ data: null }, '08:48');
    await run(exit('removed-region'), '08:49');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
    expect(await loadState()).toEqual(seededState());
  });

  it('작업 오류는 보관함도 건드리지 않음 (오류 신호로는 기록을 쓰지 않음)', async () => {
    await commit({ actions: [{ type: 'DEPART', participantId: 'p1', at: at('08:45') }] });
    await run({ error: { message: 'x' }, data: null }, '09:00');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(await loadActions()).toHaveLength(1);
  });

  it('가짜 모드에서는 위치로 기록하지 않음', async () => {
    mockIsMock = true;
    await run(exit('home'), '08:45');
    expect(await loadState()).toEqual(seededState());
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('보관한 계획이 비었거나 깨졌어도(로그아웃 뒤 · 옛 값) 던지지 않고 무시', async () => {
    await AsyncStorage.setItem('location:v1:plan', '{깨진 JSON');
    await AsyncStorage.setItem('location:v1:state', JSON.stringify({ v: 99 }));
    await expect(handleGeofenceEvent(exit('home'))).resolves.toBeUndefined();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('같은 때 온 신호 둘이 겹쳐도 한 번에 하나씩 해석 (둘 다 상태에 남음)', async () => {
    mockNowMs = at('08:45');
    await Promise.all([handleGeofenceEvent(exit('home')), handleGeofenceEvent(enter('rdest'))]);
    const state = await loadState();
    // 이탈 · 진입이 둘 다 상태에 남음 — 겹쳐 돌면 한쪽 결과가 다른 쪽 저장에 덮여 사라짐
    expect(state.regions.home.inside).toBe(false);
    expect(state.regions.rdest.inside).toBe(true);
    expect(state.arrived).toHaveLength(1);
    expect(state.departed).toHaveLength(1); // 도착이 대기 중이던 출발을 먼저 확정
  });
});

describe('작업 정의 (defineTask)', () => {
  const load = () => {
    mockDefineTask.mockClear();
    mockTasksLoaded = 0;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 불러오는 순간의 정의를 보려고 새 모듈 저장소에서 읽음
      require('../task');
    });
  };

  it('안드로이드: 불러오면 이름 respec-geofence로 작업을 정의', () => {
    load();
    expect(mockDefineTask).toHaveBeenCalledTimes(1);
    expect(mockDefineTask).toHaveBeenCalledWith(GEOFENCE_TASK, expect.any(Function));
    expect(GEOFENCE_TASK).toBe('respec-geofence');
  });

  it.each(['web', 'ios'])('%s: 네이티브 모듈을 읽지도 않음', (os) => {
    mockOS = os;
    load();
    expect(mockDefineTask).not.toHaveBeenCalled();
    expect(mockTasksLoaded).toBe(0);
  });
});

describe('로그에 좌표가 없음', () => {
  it('성공 · 일시 오류 · 영구 오류 · 작업 오류 어느 경로에도 좌표 글자가 안 나옴', async () => {
    mockRecord.mockRejectedValueOnce(new Error('Network request failed'));
    await run(exit('home'), '08:45');
    await run(enter('rdest'), '09:10');
    mockRecord.mockRejectedValue({ code: '23503', message: 'foreign key' });
    await run({ error: { message: 'boom' }, data: null }, '09:20');
    await run(enter('nowhere'), '09:30');
    expect(consoleLogs.length).toBeGreaterThan(0); // 로그는 남겼지만
    const all = consoleLogs.join('\n');
    for (const coordinate of ['37.5011', '127.0123', '37.5577', '127.0599', '37.55', '127.05']) expect(all).not.toContain(coordinate);
  });
});
