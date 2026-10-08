// 여러 화면이 같이 쓰는 이동
import { router } from 'expo-router';

// "← 이전" — 앞 화면이 없으면(주소로 바로 열기 · 알림으로 열기) 홈으로
export function backOrHome() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

// 그룹 상세 (G02) — 목업 A.openGroup처럼 그룹 탭(그룹 칸)을 밑에 깔고 상세를 올림. 뒤로 가면 그룹 목록
export function openGroupDetail(id: string) {
  router.navigate({ pathname: '/group', params: { seg: 'group' } });
  router.push({ pathname: '/groups/[id]', params: { id } });
}
