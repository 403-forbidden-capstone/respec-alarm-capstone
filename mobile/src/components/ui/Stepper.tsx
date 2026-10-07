import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string; // 값 뒤 글자 (예: "분")
  first?: boolean;
};

// 숫자 줄이기 · 늘리기 (.stepper) — 준비 시간 · 여유 시간처럼 정해진 단위로 바꾸는 값
export function Stepper({ label, value, onChange, step = 5, min = 0, max = 600, unit = '', first }: Props) {
  const down = () => onChange(Math.max(min, value - step));
  const up = () => onChange(Math.min(max, value + step));

  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <View style={styles.controls}>
        <Pressable
          onPress={down}
          disabled={value <= min}
          accessibilityRole="button"
          accessibilityLabel={`${label} ${step}${unit} 줄이기`}
          style={[styles.button, value <= min && styles.disabled]}
        >
          <Text variant="body">−</Text>
        </Pressable>
        <Text variant="bodyStrong" style={styles.value} accessibilityLiveRegion="polite">
          {value}
          {unit}
        </Text>
        <Pressable
          onPress={up}
          disabled={value >= max}
          accessibilityRole="button"
          accessibilityLabel={`${label} ${step}${unit} 늘리기`}
          style={[styles.button, value >= max && styles.disabled]}
        >
          <Text variant="body">+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  label: { fontSize: 13.5 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  button: {
    width: 36,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { minWidth: 48, textAlign: 'center', fontVariant: ['tabular-nums'] },
  disabled: { opacity: 0.35 },
});
