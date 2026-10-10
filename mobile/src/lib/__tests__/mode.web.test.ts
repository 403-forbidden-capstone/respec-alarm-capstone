import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// 웹 경로 — 주소 ?mode= → localStorage → 기본값 순서, 주소 값은 저장 (react-native Platform만 웹으로 바꿈)
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

let mockConfigured = true;
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

const store = new Map<string, string>();
const g = globalThis as unknown as { localStorage?: unknown; location?: unknown };

function open(search: string): typeof import('../mode') {
  g.location = { search };
  let out!: typeof import('../mode');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules는 require로만 새로 읽힘
    out = require('../mode');
  });
  return out;
}

describe('데이터 모드 (웹)', () => {
  beforeEach(() => {
    store.clear();
    mockConfigured = true;
    mockReady = true;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete g.localStorage;
    delete g.location;
  });

  it('주소 값이 저장값보다 먼저이고, 주소 값을 저장함', () => {
    store.set('respec.dataMode', 'real');
    const mode = open('?mode=mock');
    expect(mode.getMode()).toBe('mock');
    expect(store.get('respec.dataMode')).toBe('mock');
  });

  it('주소 값이 없으면 저장값, 그것도 없으면 기본값(연결이면 실데이터)', () => {
    store.set('respec.dataMode', 'mock');
    expect(open('').getMode()).toBe('mock');
    store.clear();
    expect(open('').getMode()).toBe('real');
  });

  it('연결 안 된 빌드에서 ?mode=real이면 가짜로 돌고 가짜로 저장함', () => {
    mockConfigured = false;
    const mode = open('?mode=real');
    expect(mode.getMode()).toBe('mock');
    expect(store.get('respec.dataMode')).toBe('mock');
  });

  it('실데이터 스위치가 꺼져 있으면 ?mode=real이어도 가짜로 돌고 가짜로 저장함 (#116)', () => {
    mockReady = false;
    const mode = open('?mode=real');
    expect(mode.getMode()).toBe('mock');
    expect(store.get('respec.dataMode')).toBe('mock');
    expect(open('').getMode()).toBe('mock');
  });

  it('바꾸면 localStorage에 바로 씀', () => {
    const mode = open('');
    mode.setMode('mock');
    expect(store.get('respec.dataMode')).toBe('mock');
  });
});
