import type { ComponentProps } from 'react';

import { screenIdVisible } from '@/lib/mode';

import { Text } from './Text';

// 화면 번호(H01 등) — 목업과 맞춰 보려고 붙인 구분용이라 개발 빌드 · 웹 미리보기에서만 보임, 출시용 폰 빌드에선 숨김 (D16과 같은 판정, lib/modePolicy showScreenIds)
// 화면 번호를 그리는 곳은 모두 이 부품(TopBar도) — 숨기는 규칙이 한 곳에만 있게
export function ScreenId({ id, tone, style }: { id: string } & Pick<ComponentProps<typeof Text>, 'tone' | 'style'>) {
  if (!screenIdVisible) return null;
  return (
    <Text variant="screenId" tone={tone} style={style}>
      {id}
    </Text>
  );
}
