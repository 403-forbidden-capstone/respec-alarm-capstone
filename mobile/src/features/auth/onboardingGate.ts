// 온보딩 화면으로 보낼지 — 판단만 하는 순수 함수 (AuthProvider가 씀, 시험: __tests__/onboardingGate.test.ts)
//
//   스위치(lib/flags ONBOARDING_IN_FLOW) | 로그인 | 프로필 읽음 | 아이디 | 온보딩으로
//   -------------------------------------|--------|------------|--------|------------
//   false (UI 받기 전, 지금)              | -      | -          | -      | 안 감 — 바로 홈
//   true                                 | 아니오 | -          | -      | 안 감 (로그인 화면이 먼저)
//   true                                 | 예     | 아직       | -      | 안 감 (읽는 동안 잠깐 뜨지 않게)
//   true                                 | 예     | 못 읽음     | -      | 안 감 (루트 레이아웃이 다시 시도 화면)
//   true                                 | 예     | 읽음       | 없음    | 감
//   true                                 | 예     | 읽음       | 있음    | 안 감
export type OnboardingGateInput = {
  inFlow: boolean; // lib/flags ONBOARDING_IN_FLOW
  signedIn: boolean;
  profileReady: boolean; // 로그인한 사용자의 프로필 읽기가 끝났음 (성공이든 실패든)
  profileFailed: boolean; // 읽기에 실패했음 — 못 읽은 것과 "아이디가 없음"은 다름. 못 읽었을 때 보내면 저장해 둔 기본값을 덮어씀
  handle: string | null | undefined; // profiles.handle (온보딩에서 정함, 그 전엔 null)
};

export function shouldOnboard({ inFlow, signedIn, profileReady, profileFailed, handle }: OnboardingGateInput): boolean {
  if (!inFlow) return false;
  return signedIn && profileReady && !profileFailed && !handle;
}
