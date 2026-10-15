import type { ReactNode } from 'react';

// 웹 미리보기 기종 프레임 — 폰에서는 틀 없이 앱만 (웹 구현은 DeviceFrame.web.tsx)
export function DeviceFrame({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
