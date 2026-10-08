// 여러 화면이 같이 쓰는 이동
import { router } from 'expo-router';

// "← 이전" — 앞 화면이 없으면(주소로 바로 열기 · 알림으로 열기) 홈으로
export function backOrHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

// 그룹 상세 (G02) — 목업 A.openGroup처럼 그룹 탭(그룹 칸)을 밑에 깔고 상세를 올림. 뒤로 가면 그룹 목록
// 탭 위에 다른 화면(기상 확인 등)이 쌓여 있으면 걷어 내고 탭으로 — navigate만 쓰면 탭 묶음이 하나 더 쌓임
// open = 여는 때마다 바뀌는 값 — 그룹 탭이 이전에 직접 고른 칸(친구)을 남기지 않고 매번 그룹 칸으로 (목업은 열 때마다 seg를 group으로)
export function openGroupDetail(id: string) {
  const tab = { pathname: '/group', params: { seg: 'group', open: String(Date.now()) } } as const;
  if (router.canDismiss()) router.dismissTo(tab);
  else router.navigate(tab);
  router.push({ pathname: '/groups/[id]', params: { id } });
}
