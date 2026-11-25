import { useSyncExternalStore } from 'react';

import { colors } from '@/theme';

// 지금 하늘에서 나온 두 가지 색 — 화면 바탕 톤(base)과 포인트 색(accent)
//   값은 features/sky의 SkySync가 넣고, 공용 부품(Screen · Button · Toggle …)이 읽음 — 부품이 features를 직접 부르지 않게 여기에 둠
//   하늘을 알기 전 · 시험에서는 기본값(회색 바탕 · 검정)
export type SkyToneValue = { base: string; accent: string };

const DEFAULT: SkyToneValue = { base: colors.bg, accent: colors.ink };

let value = DEFAULT;
const listeners = new Set<() => void>();

export function setSkyTone(next: SkyToneValue | null) {
  const to = next ?? DEFAULT;
  if (to.base === value.base && to.accent === value.accent) return;
  value = to;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => value;

export function useSkyTone(): SkyToneValue {
  return useSyncExternalStore(subscribe, read, read);
}

// 포인트 색만 — 켜진 스위치 · 채운 버튼 · 글자 버튼 · 고른 칸
export function useAccent(): string {
  return useSkyTone().accent;
}
