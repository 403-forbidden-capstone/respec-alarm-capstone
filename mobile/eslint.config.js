// ESLint — Expo 기본 규칙 (https://docs.expo.dev/guides/using-eslint/)
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // 빌드 결과 · 네이티브 폴더 · 정적 파일(목업 HTML)은 검사하지 않음
    ignores: ['dist/*', 'android/*', 'ios/*', 'public/*', '.expo/*'],
  },
]);
