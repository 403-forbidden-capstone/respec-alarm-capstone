import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

// 주간 실행 흐름 막대 (.bar) — 날마다 실행 점수 0~100
export function ScoreBars({ bars }: { bars: { label: string; score: number }[] }) {
  return (
    <View>
      {bars.map((b) => (
        <View key={b.label} style={styles.row} accessible accessibilityLabel={`${b.label}일 ${b.score}점`}>
          <Text variant="note" style={styles.label}>
            {b.label}
          </Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, b.score))}%` }]} />
          </View>
          <Text variant="note" tone="sub" align="right" style={styles.score}>
            {b.score}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 },
  label: { width: 48 },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.chip, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.ink },
  score: { width: 28, fontVariant: ['tabular-nums'] },
});
