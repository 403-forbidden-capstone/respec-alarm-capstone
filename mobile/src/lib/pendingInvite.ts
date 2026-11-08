// 로그인 전에 연 친구 링크 — 로그인(과 온보딩)이 끝난 뒤 같은 화면으로 이어가기 위한 메모 (친구 2장 2-20)
// 링크 화면(app/invite.tsx)은 로그인이 필요하면 토큰을 여기 적고 로그인으로 보냄. 루트 레이아웃(_layout.tsx)이 앱 화면이 열린 뒤 읽어서 다시 엶 (읽으면 비워짐)
// lib/afterOnboarding와 같은 방식 — 가드가 바뀌면 화면이 사라져서 화면 안에서는 이어갈 수 없음
let pending: string | null = null;

export function setPendingInvite(token: string): void {
  pending = token || null;
}

export function takePendingInvite(): string | null {
  const token = pending;
  pending = null;
  return token;
}
