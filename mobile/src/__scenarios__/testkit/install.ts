// 시나리오 시험의 "바깥만 가짜" 설치 — 시험 파일 맨 위에서 `import './testkit/install'`을 가장 먼저 불러야 함 (jest.mock이 앱 모듈을 읽기 전에 걸려야 하므로)
//   가짜로 바꾸는 것(폰 · 서버 · 설정): 안드로이드 플랫폼 · 알람 코어 네이티브 모듈 · expo-notifications · expo-location · expo-task-manager · expo-router · supabase 클라이언트 · 서버 함수 호출 · 데이터 모드
//   시험 대상(features/alarm · lib/alarmSync · features/location · features/push · lib/session · features/social)은 안 바꿈
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock 팩토리는 가짜를 불러올 때 require를 써야 함 (import는 팩토리 안에서 쓸 수 없음) */
import { jest } from '@jest/globals';

import { phone } from './phone';

// 알람 코어 — 실제 alarm-core(index · plan · nativeBackend)를 그대로 불러오되, 네이티브 모듈 자리(expo 전역의 AlarmCore)에만 가짜 폰을 끼움
//   alarm-core/index.ts의 requireOptionalNativeModule('AlarmCore')가 이 자리를 읽음 (jest-expo가 감싸 주지만 안의 함수는 그대로 phone으로 감)
const expoGlobal = globalThis as unknown as { expo?: { modules?: Record<string, unknown> } };
expoGlobal.expo = expoGlobal.expo ?? {};
expoGlobal.expo.modules = expoGlobal.expo.modules ?? {};
expoGlobal.expo.modules.AlarmCore = phone.native;

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'android', Version: 34, constants: {}, select: (o: Record<string, unknown>) => o.android ?? o.native ?? o.default },
}));

jest.mock('expo-notifications', () => (require('./phone') as typeof import('./phone')).phone.notifications);
jest.mock('expo-location', () => (require('./phone') as typeof import('./phone')).phone.location);
jest.mock('expo-task-manager', () => (require('./phone') as typeof import('./phone')).phone.taskManager);

// 로그인 화면용 바깥 모듈 — 로그아웃 정리(lib/session → lib/auth)가 불러오기만 함
jest.mock('expo-linking', () => ({ createURL: (path: string) => `respecalarm://${path}` }));
jest.mock('expo-web-browser', () => ({}));

jest.mock('expo-router', () => {
  const nav = require('./nav') as typeof import('./nav');
  return { router: nav.router, useFocusEffect: () => {} };
});

jest.mock('@/lib/supabase', () => {
  const { db } = require('./fakeDb') as typeof import('./fakeDb');
  return {
    isSupabaseConfigured: true,
    supabaseUrl: 'https://scenario.test',
    supabasePublicKey: 'scenario-key',
    supabase: {
      from: (table: string) => db.from(table),
      rpc: (name: string, args?: unknown) => db.rpc(name, args),
      auth: {
        getSession: async () => ({ data: { session: db.userId ? { user: { id: db.userId }, access_token: 'token' } : null } }),
        signOut: async () => {
          db.userId = null;
          return { error: null };
        },
        startAutoRefresh: () => {},
        stopAutoRefresh: () => {},
      },
      channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {}, unsubscribe: () => {} }),
      removeChannel: async () => 'ok',
      realtime: { setAuth: async () => {} },
    },
  };
});

jest.mock('@/lib/edge', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/lib/edge');
  const { db } = require('./fakeDb') as typeof import('./fakeDb');
  return { ...actual, callEdge: (name: string, body?: unknown) => db.callEdge(name, body) };
});

// 실데이터 모드 고정 — 가짜 데이터 모드면 맞추기 · 위치 감지가 아무것도 안 함
jest.mock('@/lib/mode', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/lib/mode');
  return { ...actual, isMock: () => false, getMode: () => 'real' };
});
