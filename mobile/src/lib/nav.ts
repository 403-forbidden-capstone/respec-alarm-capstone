// 여러 화면이 같이 쓰는 이동
import { router, type Href } from 'expo-router';

// "← 이전" — 앞 화면이 없으면(주소로 바로 열기 · 알림으로 열기) 홈으로
export function backOrHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

// 그룹 상세 (G02) — 목업 A.openGroup처럼 그룹 탭(그룹 칸)을 밑에 깔고 상세를 올림. 뒤로 가면 그룹 목록
// from = 부르는 화면이 탭인지, 탭 위에 쌓인 화면(기상 확인 등)인지 — 지금은 기상 확인('stack')만 부름 (그룹 탭 카드는 router.push 직접, D110)
//   쌓인 화면이면 걷어 내고 탭으로 — navigate만 쓰면 탭 묶음이 하나 더 쌓임
//   탭이면 탭만 바꿈 — 탭 밑에 다른 화면이 깔려 있어도(/dev/screens에서 시작) 탭 묶음을 걷어 내지 않게
// open = 여는 때마다 바뀌는 값 — 그룹 탭이 이전에 직접 고른 칸(친구)을 남기지 않고 매번 그룹 칸으로 (목업은 열 때마다 seg를 group으로)
export function openGroupDetail(id: string, from: 'tab' | 'stack') {
  const tab = { pathname: '/group', params: { seg: 'group', open: String(Date.now()) } } as const;
  if (from === 'stack' && router.canDismiss()) router.dismissTo(tab);
  else router.navigate(tab);
  router.push({ pathname: '/groups/[id]', params: { id } });
}

// 아래 탭 화면으로 (예: 02 알람 탭, D110) — 탭 위에 쌓인 화면(그룹 상세 등)에서 부르면 걷어 내고 탭으로
//   navigate만 쓰면 탭 묶음이 하나 더 쌓임 (openGroupDetail과 같은 이유). 탭에서 부르면 탭만 바꿈
export function openTab(href: Href) {
  if (router.canDismiss()) router.dismissTo(href);
  else router.navigate(href);
}
