import { Pressable } from 'react-native';

import { Text } from '@/components/ui';

// 글자만 있는 작은 버튼 (.tlink) — 섹션 제목 오른쪽 "+ 일정 추가" 등. 섹션 제목 안에서는 굵게(strong)
export function TextLink({ label, onPress, strong }: { label: string; onPress: () => void; strong?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" style={({ pressed }) => pressed && { opacity: 0.6 }}>
      <Text variant="rowLabel" tone="sub" weight={strong ? 700 : 400}>
        {label}
      </Text>
    </Pressable>
  );
}
