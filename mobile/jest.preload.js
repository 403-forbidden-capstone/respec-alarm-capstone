// Jest가 Expo의 네이티브 로거를 늦게 불러오지 않도록, jest-expo 초기화 전에 테스트용 모듈을 준비한다.
// Expo SDK 57: preset/setup.js는 expo-modules-core를 requireActual로 불러오므로
// 전역 polyfill 및 로거 대역을 먼저 설치해야 테스트 종료 뒤 비동기 경고가 나지 않는다.
// 앱 실행 환경에는 적용되지 않는다.
'use strict';

require('expo-modules-core/src/polyfill/dangerous-internal').installExpoGlobalPolyfill();

if (globalThis.expo?.modules) {
  globalThis.expo.modules.ExpoModulesCoreJSLogger = {
    addListener() {},
    removeListeners() {},
  };
}
