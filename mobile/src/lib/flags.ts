// 기능 스위치 — 아직 안 붙인 기능을 앱 흐름에서 빼 둠
// REAL_DATA_READY: 로그인 · 온보딩 · 실데이터(Supabase)를 붙였는지 (P6, #166에서 true)
//   true면 데이터 모드 규칙이 lib/modePolicy.ts 표대로 돎: 폰 출시용 빌드는 실데이터만 · 로그인 필수, 웹 · 폰 개발용은 모드를 바꿀 수 있음
//   false로 되돌리면 Supabase가 연결된 빌드도 가짜 데이터로만 돌고, 목업에 없는 로그인 · 온보딩 · 설정 화면으로 가지 않음 (#116)
export const REAL_DATA_READY = true;
