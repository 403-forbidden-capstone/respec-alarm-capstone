import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors, radius, size as sizes } from '@/theme';
import { useAccent } from '@/lib/skyTone';

type Props<T extends string | number> = {
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  value: T;
  onChange: (next: T) => void;
  label: string; // 화면 읽기용 묶음 이름
  size?: 'grid' | 'mini'; // grid = 3칸 큰 버튼 (.opts), mini = 작은 단추 묶음 (.lvopts)
};

// 몇 개 중 하나 고르기 — 중요도 (.opts) · 강도 약 중 강 (.lvopts)
// mini는 누르는 칸을 44 높이로 잡고, 검은 칸(고른 값)은 그 안에 4씩 들여서 그림 (ui의 Segmented와 같은 모양)
export function OptionGrid<T extends string | number>({ options, value, onChange, label, size = 'grid' }: Props<T>) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  const mini = size === 'mini';
  return (
    <View style={mini ? styles.miniWrap : styles.grid} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map(([v, text]) => {
        const on = v === value;
        const body = (
          <Text variant="body" tone={on ? 'inverse' : mini ? 'sub' : 'ink'} weight={on ? 600 : 400}>
            {text}
          </Text>
        );
        return (
          <Pressable
            key={String(v)}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityLabel={text}
            accessibilityState={{ selected: on }}
            style={mini ? styles.miniHit : [styles.cell, on && [styles.on, { backgroundColor: accent }]]}
          >
            {mini ? <View style={[styles.miniPill, on && [styles.on, { backgroundColor: accent }]]}>{body}</View> : body}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, height: 44, borderRadius: radius.option, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  miniWrap: { flexDirection: 'row', backgroundColor: colors.chip, borderRadius: radius.segment },
  miniHit: { width: 48, height: sizes.touch, padding: 4 },
  miniPill: { flex: 1, borderRadius: radius.segmentItem, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.ink },
});
