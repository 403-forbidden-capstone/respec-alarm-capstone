// 기능 스위치 — 아직 안 붙인 기능을 앱 흐름에서 빼 둠
// REAL_DATA_READY: 로그인 · 온보딩 · 실데이터(Supabase)를 붙였는지 (P6, #166에서 true)
//   true면 데이터 모드 규칙이 lib/modePolicy.ts 표대로 돎: 폰 출시용 빌드는 실데이터만 · 로그인 필수, 웹 · 폰 개발용은 모드를 바꿀 수 있음
//   false로 되돌리면 Supabase가 연결된 빌드도 가짜 데이터로만 돌고, 목업에 없는 로그인 · 온보딩 · 설정 화면으로 가지 않음 (#116)
export const REAL_DATA_READY = true;

// ONBOARDING_IN_FLOW: 단계 온보딩(app/onboarding.tsx)을 앱 흐름에 넣을지 (임시 온보딩을 단계 온보딩으로 바꿈, #25)
//   true: 로그인한 뒤 프로필의 onboarded_at이 비어 있으면 온보딩부터 (판정은 features/auth/onboardingGate.ts). 어느 단계를 거칠지는 아래 ONBOARDING_STEPS
//   false로 되돌리면 온보딩 없이 바로 홈 — 화면 파일은 그대로 두고 길만 막음 (주소로도 안 열림)
//   아이디(profiles.handle)가 비어 있으면 친구가 @아이디로 나를 못 찾을 뿐, 나머지 화면은 그대로 동작함
export const ONBOARDING_IN_FLOW = true;

// 온보딩 단계 id — 순서는 features/onboarding/steps.ts ONBOARDING_ORDER
export type OnboardingStepId =
  | 'handle'
  | 'nickname'
  | 'sleep'
  | 'home'
  | 'prepare'
  | 'timetable'
  | 'consent'
  | 'permissions'
  | 'share'
  | 'first'
  | 'mic';

// 단계마다 켜고 끄는 표 — 10/29 지형님: 일단 다 넣고 보면서 뺌 → 단계마다 flag (D38 기본안 C)
//   끈 단계는 건너뛰고 진행 표시(n / 전체)도 켠 단계만 셈. 화면을 만들면 켬
//   permissions: 권한 안내 단계 화면이 아직 없음 (PR 7)
//   mic: 마이크 권한 — L4(음성) 뒤에 켬. 매니페스트에 RECORD_AUDIO가 아직 없음
export const ONBOARDING_STEPS: Record<OnboardingStepId, boolean> = {
  handle: true,
  nickname: true,
  sleep: true,
  home: true,
  prepare: true,
  timetable: true,
  consent: true,
  permissions: false,
  share: true,
  first: true,
  mic: false,
};
