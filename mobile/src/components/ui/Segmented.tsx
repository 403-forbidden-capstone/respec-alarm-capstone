import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, size } from '@/theme';

import { Text } from './Text';

type Props<T extends string> = {
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  value: T;
  onChange: (next: T) => void;
  disabled?: readonly T[]; // 지금 못 고르는 값 — 흐리게 하고 눌러도 반응 없음
};

// 둘 이상 중 하나 고르기 (.seg) — 친구 / 그룹, 월간 / 주간 / 일간 등
export function Segmented<T extends string>({ options, value, onChange, disabled }: Props<T>) {
  return (
    <View style={styles.wrap} accessibilityRole="tablist">
      {options.map(([v, label]) => {
        const on = v === value;
        const off = disabled?.includes(v) ?? false;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            disabled={off}
            hitSlop={{ top: 3, bottom: 3 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled: off }}
            style={[styles.item, on && styles.on, off && styles.off]}
          >
            <Text variant="body" tone={on ? 'ink' : 'sub'} weight={on ? 600 : 400}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', backgroundColor: colors.chip, borderRadius: radius.segment, padding: 4, marginBottom: 6 },
  item: { flex: 1, height: size.segment, borderRadius: radius.segmentItem, alignItems: 'center', justifyContent: 'center' },
  on: {
    backgroundColor: colors.card,
    shadowColor: colors.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  off: { opacity: 0.35 }, // Button의 disabled와 같은 흐림
});
