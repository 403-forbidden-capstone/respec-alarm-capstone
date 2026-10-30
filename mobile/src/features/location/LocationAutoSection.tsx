import { SectionHeader } from '@/components/ui';

import { LocationAutoCard } from './components/LocationAutoCard';
import { useLocationAuto } from './hooks/useLocationAuto';

// 설정 화면의 "자동 기록" 절 — 훅(권한 · 스위치)과 카드를 이어 줌. 안드로이드 + 실데이터가 아니면 절 제목째 안 그림 (settings.tsx는 이 한 줄만 넣음)
export function LocationAutoSection() {
  const { status, auto, busy, toggle, openSettings } = useLocationAuto();
  if (status === 'unsupported') return null;
  return (
    <>
      <SectionHeader title="자동 기록" />
      <LocationAutoCard status={status} auto={auto} busy={busy} onToggle={toggle} onOpenSettings={openSettings} />
    </>
  );
}
