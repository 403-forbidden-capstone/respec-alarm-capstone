import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

type Props = {
  label: string;
  value: string | null; // 없으면 placeholder를 흐리게
  placeholder: string;
  onPress: () => void;
  first?: boolean; // 카드 안 첫 줄이면 위 구분선을 뺌
};

// 누르면 고르는 곳이 열리는 줄 — 온보딩 단계(집 · 수업 시각 · 수업 장소)가 같이 씀. 누르는 줄이라 오른쪽 끝에 ›
// 시트는 이 부품이 열지 않음 (부르는 화면이 엶)
export function PickRow({ label, value, placeholder, onPress, first }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value ?? placeholder}`}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
    >
      <Text variant="rowLabel" tone="sub">
        {label}
      </Text>
      <View style={styles.value}>
        <Text variant="bodyStrong" tone={value ? 'ink' : 'faint'} weight={value ? 600 : 400} numberOfLines={1} style={styles.text}>
          {value ?? placeholder}
        </Text>
        <Text variant="bodyStrong" tone="faint">
          ›
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14, minHeight: 52 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  value: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  text: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
