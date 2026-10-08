import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  disabledHint?: string; // 왜 못 누르는지 (기상 상태 조회 권한이 없어요)
};

// 멤버 줄 오른쪽 작은 글자 버튼 (.mini) — 못 누르면 흐리게 줄을 그음
export function MiniButton({ label, onPress, disabled, disabledHint }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={disabled ? disabledHint : undefined}
      style={({ pressed }) => [styles.button, pressed && !disabled && styles.pressed]}
    >
      <Text variant="label" tone={disabled ? 'faint' : 'sub'} style={disabled && styles.off}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { paddingVertical: 6, paddingHorizontal: 4 },
  pressed: { opacity: 0.6 },
  off: { textDecorationLine: 'line-through' },
});
