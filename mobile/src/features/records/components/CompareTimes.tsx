import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { timeParts } from '@/lib/format';
import { colors } from '@/theme';
import { useAccent } from '@/lib/skyTone';

// 기존 → 제안 시각 비교 (.cmp) — 제안 칸은 포인트 색 테두리
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
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  const { ampm, hm } = timeParts(at);
  return (
    <View style={[styles.box, highlight && [styles.boxNew, { borderColor: accent }]]} accessible accessibilityLabel={`${label} ${ampm} ${hm}`}>
      <Text variant="caption" tone="ink" align="center" style={[styles.label, highlight && { color: accent, opacity: 1 }]}>
        {label}
      </Text>
      <Text variant="compare" tone="ink" align="center">
        {hm}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 10 },
  box: { flex: 1, borderRadius: 16, padding: 12, borderWidth: 2, borderColor: 'transparent', backgroundColor: colors.chip },
  boxNew: { backgroundColor: colors.card }, // 제안 칸 — 검정 채움 대신 포인트 색 테두리
  label: { opacity: 0.7 },
});
