import { Pressable } from 'react-native';

import { Text } from '@/components/ui';

type Props = {
  label: string;
  onPress: () => void;
  strong?: boolean;
  accessibilityLabel?: string; // 글자만으로 뜻이 모자랄 때 (없으면 label을 읽음)
};

// 글자만 있는 작은 버튼 (.tlink) — 섹션 제목 오른쪽 "+ 일정 추가" 등. 섹션 제목 안에서는 굵게(strong)
export function TextLink({ label, onPress, strong, accessibilityLabel }: Props) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      <Text variant="rowLabel" tone="sub" weight={strong ? 700 : 400}>
        {label}
      </Text>
    </Pressable>
  );
}
