import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { presetName } from '@/features/location/radius';
import { colors, radius, size } from '@/theme';
import { useAccent } from '@/lib/skyTone';

type Props = {
  value: number; // 지금 고른 반경(m)
  presets: readonly number[]; // 작은 것부터 (보통 3개 → 작게 · 보통 · 크게)
  hint: string; // 한 줄 설명
  onChange: (meters: number) => void;
};

// 감지 범위 고르기 — 작게 · 보통 · 크게 3칸. 값 · 콜백만 받음 (지도 원은 부르는 쪽이 같은 값을 MapView에 줌)
// value가 어느 프리셋도 아니면(저장돼 있던 사용자 지정 값) 칸은 모두 꺼져 있고 "지금 200m"로 알려 줌
// <RadiusPicker value={150} presets={[100, 150, 300]} hint="이 원 안에 들어오면 도착으로 기록해요" onChange={setRadius} />
export function RadiusPicker({ value, presets, hint, onChange }: Props) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  const custom = !presets.includes(value);
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text variant="label">감지 범위</Text>
        {custom ? (
          <Text variant="small" tone="sub">
            지금 {value}m
          </Text>
        ) : null}
      </View>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="감지 범위">
        {presets.map((meters, i) => {
          const on = meters === value;
          const name = presetName(i, presets.length);
          return (
            <Pressable
              key={meters}
              onPress={() => onChange(meters)}
              accessibilityRole="radio"
              accessibilityLabel={name ? `${name} ${meters}미터` : `${meters}미터`}
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [styles.cell, on && [styles.cellOn, { backgroundColor: accent, borderColor: accent }], pressed && styles.pressed]}
            >
              {name ? (
                <Text variant="label" tone={on ? 'inverse' : 'ink'}>
                  {name}
                </Text>
              ) : null}
              <Text variant={name ? 'caption' : 'label'} tone={on ? 'inverse' : name ? undefined : 'ink'}>
                {meters}m
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text variant="small" tone="sub" style={styles.hint}>
        {hint}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  row: { flexDirection: 'row', gap: 8, marginTop: 6 },
  cell: {
    flex: 1,
    minHeight: size.touch,
    paddingVertical: 6,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pressed: { opacity: 0.6 },
  hint: { marginTop: 6 },
});
