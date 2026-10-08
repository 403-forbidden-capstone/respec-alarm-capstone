import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius } from '@/theme';

type Props = {
  icon: string; // + · ↳
  title: string;
  sub: string;
  dark?: boolean; // 주된 쪽은 검은 바탕
  onPress: () => void;
};

// 두 칸 타일 (.tile) — 새 그룹 만들기 · 그룹 참여하기
export function ActionTile({ icon, title, sub, dark, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title} · ${sub}`}
      style={({ pressed }) => [styles.tile, dark && styles.dark, pressed && styles.pressed]}
    >
      <Text variant="sheetTitle" tone={dark ? 'inverse' : 'ink'} weight={400} style={styles.icon}>
        {icon}
      </Text>
      <Text variant="bodyStrong" tone={dark ? 'inverse' : 'ink'}>
        {title}
      </Text>
      <Text variant="caption" tone={dark ? 'faint' : 'sub'}>
        {sub}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    height: 96,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  dark: { backgroundColor: colors.ink, borderColor: colors.ink },
  pressed: { opacity: 0.75 },
  icon: { marginBottom: 'auto' },
});
