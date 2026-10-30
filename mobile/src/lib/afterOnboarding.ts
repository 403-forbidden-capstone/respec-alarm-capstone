// 온보딩을 끝낸 뒤 처음 갈 곳 — 온보딩 화면에서 루트 레이아웃(_layout.tsx)으로 넘기는 메모
// 온보딩 화면은 프로필을 다시 읽어 needsOnboarding이 꺼지는 순간 Stack.Protected 가드에서 빠져 사라지므로,
// 화면 안에서는 "앱 화면이 열린 뒤" 이동을 할 수 없음. 그래서 화면은 여기에 적어 두고, 가드가 열린 루트가 읽어서 이동함 (읽으면 비워짐)
export type AfterOnboarding = 'schedule' | null; // schedule = 첫 일정 만들기, null = 홈에 머묾

let pending: AfterOnboarding = null;

export function setAfterOnboarding(to: AfterOnboarding): void {
  pending = to;
}

// 읽고 비움 — 한 번 읽으면 다음엔 null
export function takeAfterOnboarding(): AfterOnboarding {
  const to = pending;
  pending = null;
  return to;
}
