import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

// 기존 → 제안 값 비교 — 시각이 아닌 제안(말소리 · 배경음 · 진동)용. CompareTimes와 같은 모양, 제안 칸은 검게
export function CompareValues({ before, after }: { before: string; after: string }) {
  return (
    <View style={styles.row}>
      <Box label="기존" value={before} />
      <Text variant="body" tone="faint">
        →
      </Text>
      <Box label="제안" value={after} highlight />
    </View>
  );
}

function Box({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={[styles.box, highlight && styles.boxNew]} accessible accessibilityLabel={`${label} ${value}`}>
      <Text variant="caption" tone={highlight ? 'inverse' : 'ink'} align="center" style={styles.label}>
        {label}
      </Text>
      <Text variant="bodyStrong" tone={highlight ? 'inverse' : 'ink'} align="center">
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 10 },
  box: { flex: 1, borderRadius: 16, padding: 14, backgroundColor: colors.chip },
  boxNew: { backgroundColor: colors.ink },
  label: { opacity: 0.7 },
});
