import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius } from '@/theme';

type Props<T extends string | number> = {
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  value: T;
  onChange: (next: T) => void;
  label: string; // 화면 읽기용 묶음 이름
  size?: 'grid' | 'mini'; // grid = 3칸 큰 버튼 (.opts), mini = 작은 단추 묶음 (.lvopts)
};

// 몇 개 중 하나 고르기 — 중요도 (.opts) · 강도 약 중 강 (.lvopts)
export function OptionGrid<T extends string | number>({ options, value, onChange, label, size = 'grid' }: Props<T>) {
  const mini = size === 'mini';
  return (
    <View style={mini ? styles.miniWrap : styles.grid} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <Pressable
            key={String(v)}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityLabel={text}
            accessibilityState={{ selected: on }}
            style={[mini ? styles.mini : styles.cell, on && styles.on]}
          >
            <Text variant="body" tone={on ? 'inverse' : mini ? 'sub' : 'ink'} weight={on ? 600 : 400}>
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, height: 44, borderRadius: radius.option, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  miniWrap: { flexDirection: 'row', gap: 4, backgroundColor: colors.chip, borderRadius: 12, padding: 3 },
  mini: { width: 42, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.ink },
});
