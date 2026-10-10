import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

// 계산식 칸 (.formula) — 알람 시각 역산 · 기상 판정 기준
export function FormulaBox({ lines }: { lines: string[] }) {
  return (
    <View style={styles.box}>
      {lines.map((line) => (
        <Text key={line} variant="note" style={styles.text}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.chip, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6 },
  text: { fontVariant: ['tabular-nums'] },
});
