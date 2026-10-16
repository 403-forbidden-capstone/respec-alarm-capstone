import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// 폰(ios) 기준으로 돎 — 저장소는 메모리 Map, Supabase 연결 여부는 테스트마다 바꿈
const mockStore = new Map<string, string>();
const mockStorage = {
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
};
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: mockStorage }));

let mockConfigured = false;
jest.mock('../supabase', () => ({
  get isSupabaseConfigured() {
    return mockConfigured;
  },
}));

// 실데이터 스위치(lib/flags) — 아래 테스트는 켠 상태가 기본, 끈 상태는 따로 확인
let mockReady = true;
jest.mock('../flags', () => ({
  get REAL_DATA_READY() {
    return mockReady;
  },
}));

type Loaded = { mode: typeof import('../mode'); clock: typeof import('../clock') };

// 모듈을 새로 불러옴 — 앱을 다시 연 것과 같음 (isolateModules는 require로만 새로 읽힘)
function load(): Loaded {
  let out!: Loaded;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    out = { mode: require('../mode'), clock: require('../clock') };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const g = globalThis as unknown as { __DEV__: boolean };
const DEV = g.__DEV__;
const SCENARIO_MORNING = '2025-05-21T22:55:00.000Z';

describe('데이터 모드', () => {
  beforeEach(() => {
    mockStore.clear();
    mockConfigured = false;
    mockReady = true;
    g.__DEV__ = true; // 폰 개발용 빌드가 기본 — 출시용은 따로 확인
    jest.clearAllMocks();
  });
  afterEach(() => {
    g.__DEV__ = DEV;
  });

  it('Supabase가 연결 안 됐으면 가짜 모드이고 실데이터로 못 바꿈', async () => {
    const { mode, clock } = load();
    await flush();
    expect(mode.getMode()).toBe('mock');
    expect(mode.setMode('real')).toBe('mock');
    expect(mode.isMock()).toBe(true);
    expect(clock.now().toISOString()).toBe(SCENARIO_MORNING);
  });

  it('연결돼 있고 저장값이 없으면 실데이터, 시각은 지금', async () => {
    mockConfigured = true;
    const { mode, clock } = load();
    await flush();
    expect(mode.getMode()).toBe('real');
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('저장된 모드로 다시 열리고, 바꾸면 저장하고 시각도 따라감', async () => {
    mockConfigured = true;
    mockStore.set('respec.dataMode', 'mock');
    const { mode, clock } = load();
    await flush();
    expect(mode.getMode()).toBe('mock');
    expect(clock.now().toISOString()).toBe(SCENARIO_MORNING);

    expect(mode.setMode('real')).toBe('real');
    expect(mockStorage.setItem).toHaveBeenCalledWith('respec.dataMode', 'real');
    expect(clock.now().toISOString()).not.toBe(SCENARIO_MORNING);
  });

  it('실데이터 스위치가 꺼져 있으면 연결돼 있어도 가짜 · 저장된 실데이터도 가짜 (#116)', async () => {
    mockConfigured = true;
    mockReady = false;
    mockStore.set('respec.dataMode', 'real');
    const { mode, clock } = load();
    await flush();
    expect(mode.canUseRealData).toBe(false);
    expect(mode.getMode()).toBe('mock');
    expect(mockStorage.setItem).not.toHaveBeenCalled(); // 읽기만 하고 덮어쓰지 않음 — 스위치를 켜면 저장된 real로 다시 열림
    expect(mockStore.get('respec.dataMode')).toBe('real');
    expect(mode.setMode('real')).toBe('mock');
    expect(clock.now().toISOString()).toBe(SCENARIO_MORNING);
  });

  it('실데이터 스위치가 꺼져 있으면 저장값이 없거나 못 읽어도 가짜로 시작함', async () => {
    mockConfigured = true;
    mockReady = false;
    let opened = load();
    expect(opened.mode.getMode()).toBe('mock'); // 저장값을 읽기 전 첫 화면도
    await flush();
    expect(opened.mode.getMode()).toBe('mock');

    mockStorage.getItem.mockRejectedValueOnce(new Error('저장소 오류'));
    opened = load();
    await flush();
    expect(opened.mode.getMode()).toBe('mock');
  });

  it('저장값을 못 읽으면 기본값으로 시작함', async () => {
    mockConfigured = true;
    mockStorage.getItem.mockRejectedValueOnce(new Error('저장소 오류'));
    const { mode } = load();
    await flush();
    expect(mode.getMode()).toBe('real');
  });
  it('폰 출시용 빌드(__DEV__ false)는 실데이터 고정 — 저장값을 읽지 않고 가짜로 못 바꿈', async () => {
    g.__DEV__ = false;
    mockConfigured = true;
    mockStore.set('respec.dataMode', 'mock');
    const { mode, clock } = load();
    expect(mode.getMode()).toBe('real'); // 저장값을 기다리지 않고 첫 화면부터
    expect(mode.modeLocked).toBe(true);
    expect(mode.configError).toBe(false);
    expect(mode.devLoginVisible).toBe(false);
    await flush();
    expect(mode.getMode()).toBe('real');
    expect(mockStorage.getItem).not.toHaveBeenCalled();
    expect(mode.setMode('mock')).toBe('real');
    expect(mockStorage.setItem).not.toHaveBeenCalled();
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('폰 출시용 빌드인데 Supabase 값이 없으면 설정 오류 — 가짜로 돌지 않음', async () => {
    g.__DEV__ = false;
    mockConfigured = false;
    const { mode, clock } = load();
    await flush();
    expect(mode.configError).toBe(true);
    expect(mode.canUseRealData).toBe(false);
    expect(mode.getMode()).toBe('real');
    expect(mode.isMock()).toBe(false);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('폰 개발용은 모드를 바꿀 수 있고 개발 메뉴 이메일 로그인이 보임', async () => {
    mockConfigured = true;
    const { mode } = load();
    await flush();
    expect(mode.modeLocked).toBe(false);
    expect(mode.devLoginVisible).toBe(true);
    expect(mode.setMode('mock')).toBe('mock');
  });
});
