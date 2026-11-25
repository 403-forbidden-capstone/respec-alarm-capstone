import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius, size } from '@/theme';
import { useAccent } from '@/lib/skyTone';

type Props<T extends string> = {
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  value: T;
  onChange: (next: T) => void;
  label: string; // 화면 읽기용 묶음 이름
};

// 짧은 선택지가 많아 한 줄에 안 들어갈 때 줄을 바꿔 가며 하나 고르기 (이동 수단 5개 등) — 고른 칸은 검은 바탕. 값 · 콜백만 받음
export function ChoiceChips<T extends string>({ options, value, onChange, label }: Props<T>) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityLabel={text}
            accessibilityState={{ selected: on }}
            style={[styles.chip, on && [styles.on, { backgroundColor: accent }]]}
          >
            <Text variant="body" tone={on ? 'inverse' : 'ink'} weight={on ? 600 : 400}>
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: size.touch,
    paddingHorizontal: 16,
    borderRadius: radius.option,
    backgroundColor: colors.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  on: { backgroundColor: colors.ink },
});
