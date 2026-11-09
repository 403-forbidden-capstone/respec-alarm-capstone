// 온보딩 화면으로 보낼지 — 판단만 하는 순수 함수 (AuthProvider가 씀, 시험: __tests__/onboardingGate.test.ts)
// 기준은 아이디가 아니라 onboarded_at(온보딩을 끝낸 시각) — 아이디는 가입할 때 자동으로 생길 수 있어서 (Q1)
//
//   스위치(lib/flags ONBOARDING_IN_FLOW) | 로그인 | 프로필 읽음 | onboarded_at | 온보딩으로
//   -------------------------------------|--------|------------|--------------|------------
//   false                                | -      | -          | -            | 안 감 — 바로 홈
//   true                                 | 아니오 | -          | -            | 안 감 (로그인 화면이 먼저)
//   true                                 | 예     | 아직       | -            | 안 감 (읽는 동안 잠깐 뜨지 않게)
//   true                                 | 예     | 못 읽음     | -            | 안 감 (루트 레이아웃이 다시 시도 화면)
//   true                                 | 예     | 읽음       | 없음          | 감
//   true                                 | 예     | 읽음       | 있음          | 안 감
export type OnboardingGateInput = {
  inFlow: boolean; // lib/flags ONBOARDING_IN_FLOW
  signedIn: boolean;
  profileReady: boolean; // 로그인한 사용자의 프로필 읽기가 끝났음 (성공이든 실패든)
  profileFailed: boolean; // 읽기에 실패했음 — 못 읽은 것과 "온보딩 안 끝남"은 다름. 못 읽었을 때 보내면 저장해 둔 기본값을 덮어씀
  onboardedAt: string | null | undefined; // profiles.onboarded_at (마지막 단계에서 적음, 그 전엔 null)
};

export function shouldOnboard({ inFlow, signedIn, profileReady, profileFailed, onboardedAt }: OnboardingGateInput): boolean {
  if (!inFlow) return false;
  return signedIn && profileReady && !profileFailed && onboardedAt == null;
}

// 개인정보 안내 판이 올라갔는데 내가 동의한 판이 낮을 때 동의만 다시 받을지 (친구 13-바 · 13-14 — 판이 올라가면 다음 실행 때 다시 동의)
//   온보딩을 끝낸 계정만 — 끝내지 않은 계정은 온보딩의 동의 단계가 받음. 못 읽었을 때(오프라인)는 묻지 않음
export type ReconsentGateInput = Omit<OnboardingGateInput, 'onboardedAt'> & {
  onboardedAt: string | null | undefined;
  privacyVersion: number | null | undefined; // profiles.privacy_version — 동의한 판 (없으면 0)
  currentVersion: number; // features/onboarding/consent PRIVACY_VERSION
};

export function shouldReconsent({ inFlow, signedIn, profileReady, profileFailed, onboardedAt, privacyVersion, currentVersion }: ReconsentGateInput): boolean {
  if (!inFlow) return false;
  return signedIn && profileReady && !profileFailed && onboardedAt != null && (privacyVersion ?? 0) < currentVersion;
}
