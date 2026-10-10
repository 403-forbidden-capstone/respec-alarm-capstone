// 기능 스위치 — 아직 안 붙인 기능을 앱 흐름에서 빼 둠
// REAL_DATA_READY: 로그인 · 온보딩 · 실데이터(Supabase)를 붙였는지
//   false면 Supabase가 연결된 빌드도 가짜 데이터로만 돌고, 목업에 없는 로그인 · 온보딩 · 설정 화면으로 가지 않음 (#116)
//   로그인을 붙일 때 true로 바꾸면 데이터 모드 토글 · 로그인 흐름이 다시 살아남 (#25)
export const REAL_DATA_READY = false;
