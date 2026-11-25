import { router, type Href } from 'expo-router';

import { Segmented, toast } from '@/components/ui';
import { hasSession } from '@/lib/auth';
import { getMode, modeLocked, setMode, useMode, type DataMode } from '@/lib/mode';

const MODES = [
  ['real', '실데이터'],
  ['mock', '가짜 데이터'],
] as const;

// 모드 · 로그인 상태가 화면 묶음(Stack.Protected)에 반영된 다음 렌더 뒤에 옮김 — 막힌 묶음의 주소로는 안 열리므로 갈 곳을 직접 줌
export const goAfterRender = (href: Href) => setTimeout(() => router.replace(href), 0);

// 데이터 모드를 바꿈 — 바꾸면 처음 화면으로, 실데이터인데 저장된 로그인이 없으면 로그인으로
// 아래 토글(/dev/screens)와 웹 미리보기 왼쪽 패널(components/dev/DevicePanel)이 같이 씀 — 토스트 · 이동이 어디서 바꿔도 같음
export async function changeDataMode(next: DataMode) {
  if (next === getMode()) return; // 지금 모드를 다시 누르면 그대로 (Segmented는 같은 값도 onChange를 부름)
  if (setMode(next) !== next) {
    toast('실데이터를 쓸 수 없어 가짜 데이터로 돌아요');
    return;
  }
  toast(next === 'real' ? '실데이터 모드예요' : '가짜 데이터 모드예요. 목업 시나리오로 돌아요');
  goAfterRender(next === 'real' && !(await hasSession().catch(() => false)) ? '/login' : '/');
}

// 데이터 모드 토글 (/dev/screens)
// 폰 출시용 빌드(모드 고정, lib/modePolicy.ts)에서는 그리지 않음
export function DataModeToggle() {
  const { mode } = useMode();
  if (modeLocked) return null;

  return <Segmented options={MODES} value={mode} onChange={changeDataMode} />;
}
