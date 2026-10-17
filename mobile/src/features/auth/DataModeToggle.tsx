import { router, type Href } from 'expo-router';

import { Segmented, toast } from '@/components/ui';
import { hasSession } from '@/lib/auth';
import { modeLocked, setMode, useMode, type DataMode } from '@/lib/mode';

const MODES = [
  ['real', '실데이터'],
  ['mock', '가짜 데이터'],
] as const;

// 모드 · 로그인 상태가 화면 묶음(Stack.Protected)에 반영된 다음 렌더 뒤에 옮김 — 막힌 묶음의 주소로는 안 열리므로 갈 곳을 직접 줌
export const goAfterRender = (href: Href) => setTimeout(() => router.replace(href), 0);

// 데이터 모드 토글 (/dev/screens · 설정 개발 절) — 바꾸면 처음 화면으로, 실데이터인데 저장된 로그인이 없으면 로그인으로
// 폰 출시용 빌드(모드 고정, lib/modePolicy.ts)에서는 그리지 않음
export function DataModeToggle() {
  const { mode } = useMode();
  if (modeLocked) return null;

  async function change(next: DataMode) {
    if (next === mode) return; // 지금 모드를 다시 누르면 그대로 (Segmented는 같은 값도 onChange를 부름)
    if (setMode(next) !== next) {
      toast('실데이터를 쓸 수 없어 가짜 데이터로 돌아요');
      return;
    }
    toast(next === 'real' ? '실데이터 모드예요' : '가짜 데이터 모드예요. 목업 시나리오로 돌아요');
    goAfterRender(next === 'real' && !(await hasSession().catch(() => false)) ? '/login' : '/');
  }

  return <Segmented options={MODES} value={mode} onChange={change} />;
}
