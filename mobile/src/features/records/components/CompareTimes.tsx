import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { timeParts } from '@/lib/format';
import { colors } from '@/theme';

// 기존 → 제안 시각 비교 (.cmp) — 제안 칸은 검게
export function CompareTimes({ before, after }: { before: Date; after: Date }) {
  return (
    <View style={styles.row}>
      <Box label="기존" at={before} />
      <Text variant="body" tone="faint">
        →
      </Text>
      <Box label="제안" at={after} highlight />
    </View>
  );
}

function Box({ label, at, highlight }: { label: string; at: Date; highlight?: boolean }) {
  const { ampm, hm } = timeParts(at);
  return (
    <View style={[styles.box, highlight && styles.boxNew]} accessible accessibilityLabel={`${label} ${ampm} ${hm}`}>
      <Text variant="caption" tone={highlight ? 'inverse' : 'ink'} align="center" style={styles.label}>
        {label}
      </Text>
      <Text variant="compare" tone={highlight ? 'inverse' : 'ink'} align="center">
        {hm}
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
