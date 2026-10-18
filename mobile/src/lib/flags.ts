// 기능 스위치 — 아직 안 붙인 기능을 앱 흐름에서 빼 둠
// REAL_DATA_READY: 로그인 · 온보딩 · 실데이터(Supabase)를 붙였는지 (P6, #166에서 true)
//   true면 데이터 모드 규칙이 lib/modePolicy.ts 표대로 돎: 폰 출시용 빌드는 실데이터만 · 로그인 필수, 웹 · 폰 개발용은 모드를 바꿀 수 있음
//   false로 되돌리면 Supabase가 연결된 빌드도 가짜 데이터로만 돌고, 목업에 없는 로그인 · 온보딩 · 설정 화면으로 가지 않음 (#116)
export const REAL_DATA_READY = true;

// ONBOARDING_IN_FLOW: 임시 온보딩(app/onboarding.tsx — 아이디 · 집 · 아침 준비 기본값)을 앱 흐름에 넣을지
//   false면 로그인한 뒤 아이디가 없어도 바로 홈. UI 쪽에서 새 온보딩 화면을 받기 전에는 흐름에서 뺌 (10/18 지형님, #117과 같은 뜻, #177)
//   화면 파일은 그대로 두고 길만 막음 (주소로도 안 열림). 새 화면을 받으면 true로 바꾸고 onboarding.tsx를 그 화면으로 바꿈
//   아이디(profiles.handle)가 비어 있으면 친구가 @아이디로 나를 못 찾을 뿐, 나머지 화면은 그대로 동작함
export const ONBOARDING_IN_FLOW = false;
