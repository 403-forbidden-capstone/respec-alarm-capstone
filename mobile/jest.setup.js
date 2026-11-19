// jest 공통 준비 — features/*/api.ts가 lib/mode(isMock)를 불러오고, lib/mode는 폰 저장소(AsyncStorage)를 읽으므로 시험에서는 메모리 가짜를 씀
// (lib/mode 시험처럼 자기 가짜를 쓰는 시험은 jest.mock으로 이 설정을 덮음)
/* eslint-env jest */
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));


// Jest's React Native environment does not expose Node's native WebSocket.
// Supabase Realtime checks the global constructor as soon as createClient()
// runs, even when a test never opens a realtime connection. Provide the
// existing ws transport only in Jest; do not alter app runtime behavior.
if (typeof globalThis.WebSocket !== 'function') {
  globalThis.WebSocket = require('ws');
}

// Expo SDK 57의 fetch 전역값은 처음 접근할 때 expo-modules-core를 지연 로딩한다.
// Jest/coverage 종료 처리 중 처음 접근하면 종료된 테스트 환경에서 console.warn이 실행되어
// "Cannot log after tests are done" 오류가 날 수 있어, 환경이 살아 있는 준비 단계에서 초기화한다.
// 이 코드는 Jest 설정에서만 실행되며 앱의 실제 네트워크 동작에는 영향을 주지 않는다.
void globalThis.fetch;
