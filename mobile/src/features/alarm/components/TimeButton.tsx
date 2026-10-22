import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius, size } from '@/theme';

type Props = {
  label: string; // 보이는 글자 (오전 8:00)
  onPress: () => void;
  accessibilityLabel: string; // 읽기 도구용 (기상 시각 오전 8:00, 눌러서 고르기)
  manual?: boolean; // 직접 고른 시각이면 검게
};

// 시각을 눌러 고르는 단추 (H03 알람 시각 · H05 확인 시트) — 모양은 36 높이, 누르는 칸은 44. 글자 뒤 ⌄로 눌러서 고르는 것임을 보임
const SLOP = (size.touch - 36) / 2;

export function TimeButton({ label, onPress, accessibilityLabel, manual }: Props) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: SLOP, bottom: SLOP, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.base, manual && styles.manual, pressed && styles.pressed]}
    >
      <Text variant="bodyStrong" tone={manual ? 'inverse' : 'ink'}>
        {label}
      </Text>
      <Text variant="small" tone={manual ? 'inverse' : 'sub'}>
        ⌄
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: radius.chip,
    backgroundColor: colors.chip,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  manual: { backgroundColor: colors.ink },
  pressed: { opacity: 0.7 },
});
