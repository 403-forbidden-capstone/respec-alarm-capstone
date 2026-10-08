import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
const SCENARIO_MORNING = '2025-05-21T22:55:00.000Z';

describe('데이터 모드', () => {
  beforeEach(() => {
    mockStore.clear();
    mockConfigured = false;
    jest.clearAllMocks();
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

  it('저장값을 못 읽으면 기본값으로 시작함', async () => {
    mockConfigured = true;
    mockStorage.getItem.mockRejectedValueOnce(new Error('저장소 오류'));
    const { mode } = load();
    await flush();
    expect(mode.getMode()).toBe('real');
  });
});
