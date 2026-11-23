// 개발용 미리 보기 — /dev/sky에서 고른 날씨 · 시간대를 실제 탭 화면에 입혀 봄. 앱을 다시 열면 풀림
import type { SkyKind, SkyPhase } from './sky';

export type SkyPreview = { kind: SkyKind; phase: SkyPhase };

let preview: SkyPreview | null = null;

export function skyPreview() {
  return preview;
}

export function setSkyPreview(next: SkyPreview | null) {
  preview = next;
}
