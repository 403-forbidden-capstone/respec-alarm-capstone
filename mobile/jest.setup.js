// jest 공통 준비 — features/*/api.ts가 lib/mode(isMock)를 불러오고, lib/mode는 폰 저장소(AsyncStorage)를 읽으므로 시험에서는 메모리 가짜를 씀
// (lib/mode 시험처럼 자기 가짜를 쓰는 시험은 jest.mock으로 이 설정을 덮음)
/* eslint-env jest */
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
