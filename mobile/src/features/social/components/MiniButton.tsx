import { Pressable, StyleSheet } from 'react-native';

import { Text, toast } from '@/components/ui';
import { size } from '@/theme';

type Props = {
  label: string;
  onPress: () => void;
  disabledReason?: string; // 있으면 못 누르는 버튼 — 흐리게 보이고, 누르면 이 이유를 토스트로 알림 (수연님이 기상 상태 공유를 허용하지 않았어요)
};

// 멤버 줄 오른쪽 작은 글자 버튼 (.mini) — 누르는 칸은 44. 못 누를 때도 눌리고 이유를 알려 줌
export function MiniButton({ label, onPress, disabledReason }: Props) {
  const disabled = disabledReason != null;
  return (
    <Pressable
      onPress={disabled ? () => toast(disabledReason) : onPress}
      accessibilityRole="button"
      accessibilityHint={disabledReason}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text variant="label" tone={disabled ? 'faint' : 'sub'} style={disabled && styles.off}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minWidth: size.touch, minHeight: size.touch, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  off: { opacity: 0.55 }, // 취소선 대신 흐리게 — 글자는 그대로 읽히고 못 누른다는 것만 보임
});
