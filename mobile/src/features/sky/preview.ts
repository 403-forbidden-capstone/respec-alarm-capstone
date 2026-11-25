// 개발용 미리 보기 — /dev/sky에서 고른 날씨 · 시간대를 실제 화면에 입혀 봄. 앱을 다시 열면 풀림
import type { SkyKind, SkyPhase } from './sky';

export type SkyPreview = { kind: SkyKind; phase: SkyPhase };

let preview: SkyPreview | null = null;
const listeners = new Set<() => void>();

export function skyPreview() {
  return preview;
}

export function setSkyPreview(next: SkyPreview | null) {
  preview = next;
  listeners.forEach((l) => l());
}

// 미리 보기 값이 바뀌면 알림 — 바탕 톤 · 포인트 색(SkySync)이 바로 따라가게
export function onSkyPreview(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
