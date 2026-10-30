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
    // jest 설정 파일은 jest 전역(jest.mock 등)을 씀 — 시험 파일(__tests__)은 expo 설정이 이미 jest 전역을 앎
    files: ['jest.setup.js'],
    languageOptions: { globals: { jest: 'readonly' } },
  },
  {
    // 손으로 돌리는 node 스크립트(scripts/*.mjs)는 node 전역을 씀 (예: 알람 소리 합성 make-alarm-sounds.mjs의 Buffer)
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: { globals: { Buffer: 'readonly', process: 'readonly', console: 'readonly' } },
  },
  {
    // effect 안에서 setState를 바로 부르는 곳이 main에 이미 있어 이 두 파일만 경고로 둠. 새 코드에서는 그대로 에러
    //   AuthProvider: 로그아웃 때 setLoaded — 작성자가 렌더 중 state 조정으로 바꿀지 판단
    //   alarm-test: async refresh() 호출 — setState가 await 뒤라 오탐
    files: ['src/features/auth/AuthProvider.tsx', 'src/app/dev/alarm-test.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
