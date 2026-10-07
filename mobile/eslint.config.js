// ESLint — Expo 기본 규칙 (https://docs.expo.dev/guides/using-eslint/)
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // 빌드 결과 · 네이티브 폴더 · 정적 파일(목업 HTML)은 검사하지 않음
    ignores: ['dist/*', 'android/*', 'ios/*', 'public/*', '.expo/*'],
  },
  {
    rules: {
      // effect 안에서 setState를 바로 부르는 곳(AuthProvider 로그아웃 비우기 · alarm-test 첫 읽기)이
      // 이미 main에 있어 경고로 둠. async 함수 호출은 오탐이고, 나머지는 작성자가 렌더 중 state 조정으로 바꿀지 판단
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
