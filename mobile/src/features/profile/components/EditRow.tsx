import { Pressable, StyleSheet, View } from 'react-native';

import { KeyValueRow, Text } from '@/components/ui';
import { colors, size } from '@/theme';

type Props = {
  label: string;
  value: string;
  onPress?: () => void; // 없으면 고칠 수 없는 줄 — 읽기 전용으로 그리고 › 도 숨김
  first?: boolean; // 카드 안 첫 줄이면 위 구분선을 뺌
};

// 설정의 값 한 줄 — 누르면 고치는 시트가 열림 (오른쪽 ›). 값 · 콜백만 받음
export function EditRow({ label, value, onPress, first }: Props) {
  if (!onPress) return <KeyValueRow first={first} label={label} value={value} />;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} 바꾸기, 지금 ${value}`}
      style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
    >
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <View style={styles.value}>
        <Text variant="bodyStrong" align="right" numberOfLines={1} style={styles.text}>
          {value}
        </Text>
        <Text variant="bodyStrong" tone="faint">
          ›
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: size.touch, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  label: { fontSize: 13.5 },
  value: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  text: { flexShrink: 1 },
});
